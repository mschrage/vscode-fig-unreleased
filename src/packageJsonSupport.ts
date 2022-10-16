import { compact, findCustomArray } from '@zardoy/utils'
import { firstExists } from '@zardoy/vscode-utils/build/fs'
import { getJsonCompletingInfo } from '@zardoy/vscode-utils/build/jsonCompletions'
import { findNodeAtLocation, getLocation, Node, parseTree, parse as parseJson } from 'jsonc-parser'
import _ from 'lodash'
import { commands, DocumentSelector, languages, Range, ShellExecution, Task, tasks, TaskScope, TextDocument, Uri, workspace } from 'vscode'
import { RegisterLanguageSupportOptions, API } from './extension-api'
import { urisToDocuments } from './external-utils'
import { findUpMultiplePackageJson } from './find-up'

const SUPPORTED_PACKAGE_JSON_SELECTOR: DocumentSelector = { pattern: '**/package.json', scheme: '*' }

/**
 * these specs come from npm packages
 * they should be probably installed locally
 */
const PACKAGES_COMMANDS: Array<string | [cmd: string, pkg: string]> = [
    'eslint',
    'electron',
    ['dotenv', 'dotenv-cli'],
    'esbuild',
    'webpack',
    'jest',
    'vite',
    'pre-commit',
    'rollup',
    'vue',
    'ts-node',
    ['tsc', 'typescript'],
]

// null is placeholder that means data are being loaded, so we don't request them again
const depsCachePerUri = new Map<string, null | { current: string[]; parent: string[] }>()

let initializedApi: API

const options: RegisterLanguageSupportOptions = {
    // todo fix \"
    provideSingleLineRangeFromPosition(document, position) {
        const offset = document.offsetAt(position)
        const location = getLocation(document.getText(), offset)
        if (!location?.matches(['scripts', '*'])) return
        const jsonCompletingInfo = getJsonCompletingInfo(location, document, position)
        const { insideStringRange } = jsonCompletingInfo || {}
        if (!insideStringRange) return
        return insideStringRange
    },
    getAllSingleLineCommandLocations(document) {
        const root = parseTree(document.getText())
        if (!root) return
        const scriptsRootNode = findNodeAtLocation(root, ['scripts'])
        const scriptsNodes = scriptsRootNode?.children
        if (!scriptsNodes) return
        const nodeObjectMap = (nodes: Node[], type: 'prop' | 'value') => {
            const indexGetter = type === 'prop' ? 0 : 1
            return compact(nodes.map(value => value.type === 'property' && value.children![indexGetter]))
        }
        const ranges = [] as Range[]
        for (const node of nodeObjectMap(scriptsNodes, 'value')) {
            const startOffset = node.offset + 1
            const range = new Range(document.positionAt(startOffset), document.positionAt(startOffset + node.length - 2))
            ranges.push(range)
        }
        return ranges
    },
    pathAutoRename: {
        glob: 'package.json',
    },
    isSpecCanBeUsed,
}

const getDepsFromDocument = (document: TextDocument) => {
    try {
        const { dependencies, devDependencies, optionalDependencies, peerDependencies } = parseJson(document.getText()) ?? {}
        return [dependencies, devDependencies, optionalDependencies, peerDependencies].filter(Boolean).flatMap(deps => Object.keys(deps))
    } catch {
        return []
    }
}

function isSpecCanBeUsed(specName: string, uri: Uri) {
    if (!uri.path.endsWith('package.json')) return true
    const specPackagesData = findCustomArray(PACKAGES_COMMANDS, pkgMaybeArr => {
        const normalizedData = Array.isArray(pkgMaybeArr)
            ? {
                  command: pkgMaybeArr[0],
                  pkg: pkgMaybeArr[1],
              }
            : {
                  command: pkgMaybeArr,
                  pkg: pkgMaybeArr,
              }
        if (normalizedData.command !== specName) return false
        return normalizedData
    })
    if (!specPackagesData) return true
    const { pkg } = specPackagesData
    const dirCache = depsCachePerUri.get(uri.toString())
    if (dirCache) {
        if (![...dirCache.current, ...dirCache.parent].includes(pkg)) return `${pkg} is not installed`
    } else if (dirCache !== null) {
        depsCachePerUri.set(uri.toString(), null)
        findUpMultiplePackageJson(uri)
            .then(async uris => {
                for (const parentUri of uris) {
                    // set to null placholder (indicate loading) if still missing data
                    if (!depsCachePerUri.get(parentUri.toString())) depsCachePerUri.set(parentUri.toString(), null)
                }
                const documents = await urisToDocuments(uris)
                const collectedPackages: string[] = []
                for (const document of documents) {
                    const docPackages = getDepsFromDocument(document)
                    // we're going from current document to root
                    depsCachePerUri.set(document.uri.toString(), { current: docPackages, parent: [...collectedPackages] })
                    collectedPackages.push(...docPackages)
                }
                initializedApi.events.fire('lint', [documents[0]])
            })
            .catch(console.error)
    }
    return true
}

const registerPackageJsonDepsWatcher = () => {
    workspace.onDidChangeTextDocument(({ document }) => {
        if (!languages.match(SUPPORTED_PACKAGE_JSON_SELECTOR, document)) return
        const newDocDeps = getDepsFromDocument(document)
        const key = document.uri.toString()
        const existingCache = depsCachePerUri.get(key)
        if (!existingCache || _.isEqual(newDocDeps, existingCache.current)) return
        depsCachePerUri.set(key, { current: newDocDeps, parent: existingCache.parent })
        initializedApi.events.fire('lint', [document])
    })
}

export const registerPackageJsonSupport = (api: API) => {
    initializedApi = api
    api.registerLanguageSupport(SUPPORTED_PACKAGE_JSON_SELECTOR, options)
    registerPackageJsonDepsWatcher()

    registerInstallCodeAction()
}

// these have been copied instead of doing integration with npm-the-fastest

const registerInstallCodeAction = () => {
    const installPackagesCommand = '_installMissingPackageJsonPackages'

    commands.registerCommand(installPackagesCommand, async (runCommand: string, cwd: string) => {
        const title = 'Install packages'
        const task = new Task(
            {
                type: 'shell',
            },
            TaskScope.Workspace,
            title,
            title,
            new ShellExecution(runCommand, { cwd }),
        )
        task.presentationOptions.focus = false
        await tasks.executeTask(task)
    })

    languages.registerCodeActionsProvider(SUPPORTED_PACKAGE_JSON_SELECTOR, {
        async provideCodeActions(document, requestingRange, context, token) {
            const diagnostic = context.diagnostics.find(({ range, source }) => range.contains(requestingRange) && source === 'fig')
            if (diagnostic?.code !== 'commandNotAllowedContext') return
            // todo think of a better way to provide a package instead of parsing message
            const pkg = diagnostic.message.split(' ')[0]!
            const preferredPm = await getPrefferedPackageManager(Uri.joinPath(document.uri, '..'))
            const installCommand = `${preferredPm} add ${pkg}`
            return [
                {
                    title: `Run ${installCommand}`,
                    command: {
                        title: '',
                        command: installPackagesCommand,
                        arguments: [installCommand],
                    },
                },
            ]
        },
    })
}

const packageManagerLockfiles = {
    pnpm: 'pnpm-lock.yaml',
    yarn: 'yarn.lock',
    npm: 'package-lock.json',
}

const getPrefferedPackageManager = async (cwd: Uri) => {
    let preffereddFromNpm = workspace.getConfiguration('npm', cwd).get<string>('packageManager')
    if (preffereddFromNpm === 'auto') preffereddFromNpm = undefined
    // TODO move it to bottom and always use workspace client
    if (preffereddFromNpm) return preffereddFromNpm
    const name = await firstExists(
        Object.entries(packageManagerLockfiles).map(([name, lockfile]) => ({
            name,
            uri: Uri.joinPath(cwd, lockfile),
        })),
    )
    if (name) return name

    // simplified
    return 'npm'
}
