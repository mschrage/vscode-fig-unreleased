import { getJsonCompletingInfo } from '@zardoy/vscode-utils/build/jsonCompletions'
import { findNodeAtLocation, getLocation, Node, parseTree } from 'jsonc-parser'
import { compact } from 'lodash'
import { DocumentSelector, Range } from 'vscode'
import { RegisterLanguageSupportOptions, API } from './extension-api'

const SUPPORTED_PACKAGE_JSON_SELECTOR: DocumentSelector = { pattern: '**/package.json', scheme: '*' }

/**
 * these specs come from npm packages
 * they should be probably installed locally
 */
const FIG_PACKAGES_COMMANDS = ['eslint', 'electron', 'dotenv', 'esbuild', 'webpack', 'jest', 'vite', 'pre-commit', 'rollup', 'vue', 'ts-node', 'tsc']

// todo fix \" & spec '
const options: RegisterLanguageSupportOptions = {
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
}

export const registerPackageJsonSupport = (api: API) => {
    api.registerLanguageSupport(SUPPORTED_PACKAGE_JSON_SELECTOR, options)
}
