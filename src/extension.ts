import _FIG_ALL_SPECS from 'FIG_ALL_SPECS'
import {
    CancellationTokenSource,
    commands,
    CompletionItem,
    CompletionItemKind,
    CompletionItemLabel,
    CompletionItemTag,
    CompletionTriggerKind,
    DiagnosticSeverity,
    Disposable,
    DocumentSelector,
    EventEmitter,
    ExtensionContext,
    FileType,
    Hover,
    languages,
    LocationLink,
    MarkdownString,
    Position,
    Range,
    SelectionRange,
    SemanticTokensBuilder,
    SemanticTokensLegend,
    SnippetString,
    Tab,
    TabInputText,
    TextDocument,
    TextEdit,
    Uri,
    window,
    workspace,
    WorkspaceEdit,
} from 'vscode'
import { API, RegisterLanguageSupportOptions, FeatureControl } from './extension-api'
import { compact, ensureArray, findCustomArray } from '@zardoy/utils'
import { parse } from './shell-quote-patched'
import _ from 'lodash'
import { relative } from 'path-browserify'
import { niceLookingCompletion, oneOf, prepareNiceLookingCompletinons, urisToDocuments } from './external-utils'
import { specGlobalIconMap, stringIconMap } from './customDataMaps'
import { registerShellSupport } from './shellscriptSupport'
import { registerPackageJsonSupport } from './packageJsonSupport'

const CONTRIBUTION_PREFIX = 'figUnreleased'

const getFigSubcommand = (__spec: Fig.Spec) => {
    const _spec = typeof __spec === 'function' ? __spec() : __spec
    const spec = 'versionedSpecPath' in _spec ? undefined! : _spec
    return spec
}

const ALL_LOADED_SPECS = _FIG_ALL_SPECS.map(mod => mod.default).map(value => getFigSubcommand(value)!)

let isScriptExecutionAllowed = false

const registeredLanguageProviders: RegisteredLanguageProvider[] = []
// these callback will be fired only when language support is added via api AFTER activation
const languageSupportRegisteredEvent = new EventEmitter<void>()
const relintEvent = new EventEmitter<TextDocument[] | undefined>()
const specAddedEvent = new EventEmitter<void>()

export const activate = ({}: ExtensionContext) => {
    isScriptExecutionAllowed = workspace.isTrusted
    workspace.onDidGrantWorkspaceTrust(() => {
        isScriptExecutionAllowed = true
    })

    registerCommands()
    prepareNiceLookingCompletinons()
    registerUpdateOnFileRename()
    initSettings()

    // do parsing & linting after ext host initializing
    setTimeout(() => {
        registerLinter()
    })

    const api: API = {
        /** let other extensions contribute/extend with their completions */
        addCompletionsSpec(rootSubcommand) {
            ALL_LOADED_SPECS.push(rootSubcommand)
            languageSupportRegisteredEvent.fire()
            specAddedEvent.fire()
            // todo highlight refresh
        },
        getCompletionsSpecs() {
            return ALL_LOADED_SPECS
        },
        registerLanguageSupport,

        events: {
            fire(type, ...args) {
                switch (type) {
                    case 'lint':
                        relintEvent.fire(...args)
                        break
                }
            },
            onDidChangeSpecs: specAddedEvent.event,
        },
    }

    registerShellSupport(api)
    registerPackageJsonSupport(api)

    return api
}

const globalSettings = {
    insertSpace: 'ifSubcommandOrOptionTakeArguments' as 'off' | 'always' | 'ifSubcommandOrOptionTakeArguments',
    defaultFilterStrategy: 'prefix' as Exclude<Fig.Arg['filterStrategy'], 'default'>,
    autoParameterHints: 'afterSuggestionSelect' as 'off' | 'afterSpace' | 'afterSuggestionSelect',
    scriptEnable: true,
    scriptAllowList: [] as string[],
    scriptTimeout: 5000,
    useFileIcons: true,
    mixins: {} as { [commandLocation: string]: Array<{ name: string; insertValue?: string; description?: string }> },
    ignoreClis: [] as string[],
}

// #region Constants

// probably vsce, vercel, volta, turbo, serve
// todo other for package.json: suggest only installed clis, try to ban macos-only
// #endregion

// I included regions, so you can easily collapse categories.

// #region types
type EventCallback<T> = (event: T) => void

interface RegisteredLanguageProvider extends RegisterLanguageSupportOptions, FeatureControl {
    selector: DocumentSelector
}

type CommandPartTuple = [contents: string, offset: number, isOption: boolean]
type CommandPartParseTuple = [contents: string, offset: number]
type CommandsParts = Array<{ parts: CommandPartParseTuple[]; start: number; op: string }>

// todo resolve sorting!
interface DocumentInfo extends ParseCommandStringResult {
    // used for providing correct editing range
    includeCached: boolean
    realPos: Position | undefined
    startPos: Position | undefined
    specName: string
    inputString: string
    // prefixed to try avoid usages
    _document: TextDocument
    // partsToPos: PartTuple[]
    // currentCommandPos: number
    /** all command options except currently completing */
    usedOptions: UsedOption[]
    parsedInfo: {
        completingOptionValue:
            | {
                  // TODO also strip
                  currentEnteredValue: string
                  paramName: string
              }
            | undefined
        completingOptionFull: [optionIndex: number, argIndex: number] | undefined
    }
}

// todo review options mb add them to base
type DocumentInfoForCompl = DocumentInfo & {
    /** Fallback icon */
    kind?: CompletionItemKind
    sortTextPrepend?: string
    specName?: string
    rangeShouldReplace?: boolean
}

type UsedOption = string

// #endregion
// #region Suggestions generators
// they return vscode suggestions

// current sorting is hardcoded:
// - a option arg suggestions
// - b just args
// - c subcommands
// - d options

// todo filterStragegy
const figBaseSuggestionToVscodeCompletion = (
    baseCompetion: Fig.BaseSuggestion,
    initialName: string,
    {
        currentPartValue,
        allParts,
        currentPartIndex,
        kind,
        sortTextPrepend = '',
        realPos,
        startPos,
        specName,
        rangeShouldReplace = true,
        assignGlobalCompletionIcon,
    }: DocumentInfoForCompl & { sortTextPrepend: string; assignGlobalCompletionIcon?: boolean },
): CompletionItem | undefined => {
    const { displayName, insertValue, description, icon, priority = 50, hidden, deprecated } = baseCompetion

    if (hidden && currentPartValue !== initialName) return undefined
    const completion = new CompletionItem({ label: displayName || initialName }) as Omit<CompletionItem, 'label'> & { label: CompletionItemLabel }

    completion.insertText = insertValue !== undefined ? new SnippetString().appendText(insertValue) : undefined
    if (completion.insertText) {
        let placeholderCount = 1
        completion.insertText.value = completion.insertText.value.replaceAll('{cursor\\}', () => {
            return `$${placeholderCount++}`
        })
    }
    completion.documentation = (description && new MarkdownString(description)) || undefined
    // vscode uses .sort() on completions
    completion.sortText = sortTextPrepend + (100 - priority).toString().padStart(3, '0')
    if (kind) completion.kind = kind
    if (deprecated) completion.tags = [CompletionItemTag.Deprecated]
    if (currentPartValue.trim() && realPos && startPos) {
        const curPart = allParts[currentPartIndex]
        // weird to see after "--
        // todo
        // const curStartPos = startPos.translate(0, currentPartOffset)
        const curStartPos = realPos.translate(0, -curPart[0].replace(/^ /, '').length)
        const curEndPos = curStartPos.translate(0, curPart[0].length)
        completion.range = new Range(curStartPos, rangeShouldReplace ? curEndPos : realPos)
    }

    if (globalSettings.useFileIcons) {
        let fileIcon: string | void = icon && stringIconMap[icon]
        fileIcon ??= assignGlobalCompletionIcon ? getGlobalCompletionIcon(specName) : undefined
        if (fileIcon) Object.assign(completion, niceLookingCompletion(fileIcon))
    }
    // else if (icon && [...icon].length === 1) completion.label.label = `${icon} ${completion.label.label}`

    return completion
}

const getRootSpecCompletions = (info: Omit<DocumentInfoForCompl, 'sortTextPrepend'>, includeOnlyList?: string[]) => {
    return compact(
        ALL_LOADED_SPECS.map(specCommand => {
            let { name } = specCommand
            // fig behavior
            if (Array.isArray(name)) name = name[0]
            if (!doSuggestFiltering(specCommand, info) || globalSettings.ignoreClis.includes(name) || name.includes('/')) return
            if (includeOnlyList && !includeOnlyList.includes(name)) return
            const completion = figBaseSuggestionToVscodeCompletion(specCommand, name, {
                ...info,
                specName: name,
                sortTextPrepend: '',
                assignGlobalCompletionIcon: true,
            })
            if (!completion) return
            if (!completion.kind) Object.assign(completion, niceLookingCompletion('.sh'))
            return completion
        }),
    )
}

/** doesn't support history */
const templateToSuggestions = async (inputTemplate: Fig.Template, info: DocumentInfo) => {
    const templates = ensureArray(inputTemplate)
    let includeFilesKindType: FileType | true | undefined
    const suggestions: Fig.Suggestion[] = []
    if (templates.includes('folders')) includeFilesKindType = FileType.Directory
    if (templates.includes('filepaths')) includeFilesKindType = true
    // todo
    const includeHelp = templates.includes('help')
    if (includeFilesKindType) {
        const cwd = getCwdUri(info._document)
        if (cwd) {
            suggestions.push(...(await getFilesSuggestions(cwd, info.currentPartValue ?? '', includeFilesKindType === true ? undefined : includeFilesKindType)))
        }
    }
    return suggestions
}

const templateOrGeneratorsToCompletion = async ({ template: _template, generators }: Pick<Fig.Arg, 'template' | 'generators'>, info: DocumentInfo) => {
    const collectedSuggestions = _template ? await templateToSuggestions(_template, info) : []
    for (const { template, filterTemplateSuggestions } of ensureArray(generators ?? [])) {
        if (!template) continue
        let suggestions = await templateToSuggestions(template, info)
        if (filterTemplateSuggestions) {
            suggestions = filterTemplateSuggestions(
                suggestions.map(suggestion => ({
                    ...suggestion,
                    name: suggestion.name as string,
                    context: { templateType: template as any },
                })),
            )
        }
        collectedSuggestions.push(...suggestions)
    }
    return collectedSuggestions.map(suggestion => figSuggestionToCompletion(suggestion, info))
}

const figSubcommandsToVscodeCompletions = (subcommands: Fig.Subcommand[], info: DocumentInfo): CompletionItem[] | undefined => {
    const { currentPartValue = '' } = info
    return compact(
        subcommands.map(subcommand => {
            if (!doSuggestFiltering(subcommand, info)) return
            const nameArr = ensureArray(subcommand.name)
            const completion = figBaseSuggestionToVscodeCompletion(subcommand, nameArr.join(', '), {
                ...info,
                kind: CompletionItemKind.Module,
                sortTextPrepend: 'c',
            })
            if (!completion) return
            // todo use the same logic from options
            completion.insertText = nameArr.find(name => name.toLowerCase().includes(currentPartValue.toLowerCase())) ?? nameArr[0]
            let insertSpace = subcommand.requiresSubcommand
            if (!insertSpace) {
                // todo is that right?
                if (subcommand.subcommands) insertSpace = true
                for (const arg of ensureArray(subcommand.args ?? [])) {
                    if (arg.isOptional) continue
                    insertSpace = true
                    break
                }
            }
            addInsertSpaceToCompletion(completion, !!insertSpace, info)
            return completion
        }),
    )
}

const figSuggestionToCompletion = (
    suggestion: string | Fig.Suggestion,
    info: DocumentInfoForCompl,
    { filterStrategy = true as Fig.Arg['filterStrategy'] | boolean } = {},
) => {
    if (typeof suggestion === 'string')
        suggestion = {
            name: suggestion,
        }
    suggestion.name ??= ''
    if (
        filterStrategy !== false &&
        !doSuggestFiltering(
            {
                name: suggestion.name,
                filterStrategy: filterStrategy === true ? 'default' : filterStrategy,
            },
            info,
        )
    ) {
        return
    }
    const completion = figBaseSuggestionToVscodeCompletion(suggestion, ensureArray(suggestion.name)[0]!, {
        kind: CompletionItemKind.Constant,
        sortTextPrepend: 'a',
        ...info,
    })
    if (!completion) return
    if (oneOf(suggestion.type, 'folder', 'file')) {
        const isDir = suggestion.type === 'folder'
        const { currentPartValue, realPos } = info
        const pathLastPart = currentPartValue.split('/').pop()!
        Object.assign(completion, {
            kind: isDir ? CompletionItemKind.Folder : CompletionItemKind.File,
            // restore icons on dirs, since we add trailing /
            detail: isDir ? (suggestion.name as string).slice(0, -1) : undefined,
            command: isDir
                ? {
                      command: 'editor.action.triggerSuggest',
                      title: '',
                  }
                : undefined,
            // todo-low
            range: realPos && new Range(realPos.translate(0, -pathLastPart.replace(/^ /, '').length), realPos),
            shouldBeCached: true,
        } as CustomCompletionItem)
    }
    return completion
}

const filterSuggestions = (
    suggestions: Fig.Suggestion[],
    word: string,
    { filterStrategy = globalSettings.defaultFilterStrategy }: Pick<Fig.Arg, 'filterStrategy'>,
) => {
    const filterFn = (name: string) => name[filterStrategy === 'fuzzy' ? 'includes' : 'startsWith'](word)
    // todo also return that matched name
    return suggestions.filter(({ name: names }) => ensureArray(names).some(name => filterFn(name ?? '')))
}

// this cache lives between completion triggers
let tempTriggerCache:
    | {
          document: TextDocument
          allTokensExceptCurrent: string[]
          oldToken: string
          suggestions: Fig.Suggestion[]
      }
    | undefined

const generatorsCache = new Map<
    Fig.Generator,
    {
        dirPath?: string
        updated: number
        suggestions: Fig.Suggestion[]
    }
>()

const figGeneratorScriptToCompletions = async (
    { generators = [], debounce, filterStrategy }: Pick<Fig.Arg, 'debounce' | 'generators' | 'filterStrategy'>,
    info: DocumentInfo,
) => {
    if (debounce) return
    const { currentPartIndex, currentPartValue, allParts } = info
    if (tempTriggerCache) {
        const { document, allTokensExceptCurrent } = tempTriggerCache
        if (document !== info._document || !allParts.filter((_, i) => i !== currentPartIndex).every(([token], i) => allTokensExceptCurrent[i] === token)) {
            tempTriggerCache = undefined
        }
    }
    const cwdUri = getCwdUri(info._document)
    // todo allow custom generators, but without skip cache by dir
    if (!cwdUri || cwdUri.scheme !== 'file') return
    const cwdPath = cwdUri.fsPath
    if (!cwdPath) return
    const executeShellCommandShared = (commandToExecute: string) => {
        try {
            if (!globalSettings.scriptEnable || !isScriptExecutionAllowed) throw new Error('Script execution is not enabled')
            const { scriptAllowList } = globalSettings
            if (scriptAllowList.length) {
                // use simplified parsing for performance reasons
                for (const command of commandToExecute.split(/(&&?|\|\|?|;)/)) {
                    const commandName = command.trimStart().split(' ')[0]
                    const isCommandBanned = () => {
                        return !scriptAllowList.includes(commandName)
                    }
                    if (isCommandBanned()) throw new Error(`Cannot execute script as ${commandName} is banned from user settings`)
                }
            }
            const util = require('util') as typeof import('util')
            const child_process = require('child_process') as typeof import('child_process')
            const exec = util.promisify(child_process.exec)
            const newExec = exec(commandToExecute, { cwd: cwdPath })
            return {
                exec: newExec.child,
                out: newExec.then(
                    ({ stdout }) => stdout.trim(),
                    () => '',
                ),
            }
        } catch (err) {
            // align with fig behavior
            return {
                out: '',
            }
        }
    }

    const collectedCompletions: CompletionItem[] = []
    const addSuggestions = (suggestions: Fig.Suggestion[], filterTermUsed: boolean) => {
        collectedCompletions.push(
            ...compact(
                suggestions.map(suggestion => {
                    const completion = figSuggestionToCompletion(suggestion, info, { filterStrategy: !filterTermUsed })
                    if (!completion) return
                    // todo probably it can be improved
                    if (filterTermUsed) completion.range = undefined
                    return completion
                }),
            ),
        )
    }

    generators = ensureArray(generators)
    // todo use promise.all
    for (const generator of generators) {
        let { script, scriptTimeout, postProcess, splitOn, custom, trigger = () => false, getQueryTerm, cache } = generator
        // todo support
        if (typeof trigger !== 'undefined' && typeof trigger !== 'function') continue
        if (cache) {
            const cachedGenerator = generatorsCache.get(generator)
            const { ttl = 3600 } = cache
            const cacheIsGood =
                !!cachedGenerator && (!cache.cacheByDirectory || cachedGenerator.dirPath === cwdPath) && Date.now() - cachedGenerator.updated < ttl
            if (cacheIsGood) {
                addSuggestions(cachedGenerator.suggestions, false)
                continue
            }
        }
        let queryTermUsed = false
        const filterUsingQueryTerm = (suggestions: Fig.Suggestion[]) => {
            // shouldn't queryTerm also be cached?
            const queryTerm =
                typeof getQueryTerm === 'string'
                    ? getQueryTerm
                    : getQueryTerm?.(
                          // todo pass pass that after requiresSeparator
                          currentPartValue,
                      )
            queryTermUsed = queryTerm !== undefined
            return queryTerm ? filterSuggestions(suggestions, queryTerm, { filterStrategy }) : suggestions
        }
        if (tempTriggerCache && trigger && !trigger(currentPartValue, tempTriggerCache.oldToken)) {
            // todo it seems it doesn't affect script
            addSuggestions(filterUsingQueryTerm(tempTriggerCache.suggestions), queryTermUsed)
        } else {
            const prevTokensIncludingPosition = allParts.slice(0, currentPartIndex + 1).map(([token]) => token)
            const locallyCollectedSuggestions: Fig.Suggestion[] = []
            if (custom) {
                try {
                    const customSuggestions = await custom(
                        prevTokensIncludingPosition,
                        async command => {
                            const res = executeShellCommandShared(command)
                            return await res.out
                        },
                        {
                            currentProcess: '',
                            sshPrefix: '',
                            currentWorkingDirectory: cwdPath,
                        },
                    )
                    locallyCollectedSuggestions.push(...filterUsingQueryTerm(customSuggestions))
                } catch (err) {
                    console.error(err)
                }
            }
            if (script) {
                script = typeof script === 'function' ? script(prevTokensIncludingPosition) : script
                let currentExec: import('child_process').ChildProcess | undefined
                const out = await Promise.race<string>([
                    (async (): Promise<string> => {
                        const result = executeShellCommandShared(script as string)
                        currentExec = result.exec
                        return await result.out
                    })(),
                    new Promise(resolve => {
                        setTimeout(() => {
                            currentExec?.kill()
                            resolve('')
                        }, scriptTimeout ?? globalSettings.scriptTimeout)
                    }),
                ])
                if (!postProcess && !splitOn) throw new Error(`Invalid ${info.specName} generator: either postProcess or splitOn must be defined`)
                try {
                    const suggestions = splitOn
                        ? out
                              .split(splitOn)
                              .map(x => x.trim())
                              .filter(Boolean)
                              .map((name): Fig.Suggestion => ({ name }))
                        : postProcess!(out, prevTokensIncludingPosition)
                    locallyCollectedSuggestions.push(...suggestions)
                } catch (err) {
                    // don't let completion provider fail
                    console.error(err)
                }
            }
            if (cache) {
                generatorsCache.set(generator, {
                    updated: Date.now(),
                    suggestions: locallyCollectedSuggestions,
                    dirPath: cwdPath,
                })
            }
            addSuggestions(locallyCollectedSuggestions, queryTermUsed)
            tempTriggerCache = {
                document: info._document,
                allTokensExceptCurrent: [...allParts.slice(0, currentPartIndex), ...allParts.slice(currentPartIndex + 2)].map(([token]) => token),
                oldToken: currentPartValue,
                suggestions: locallyCollectedSuggestions,
            }
        }
    }
    return collectedCompletions
}

// option or subcommand arg
const figArgToCompletions = async (arg: Fig.Arg, documentInfo: DocumentInfo) => {
    const completions: (CompletionItem | undefined)[] = []
    // does it make sense to support it here?
    if (arg.suggestCurrentToken)
        completions.push({
            label: documentInfo.currentPartValue,
            kind: CompletionItemKind.Text,
            sortText: 'a000',
        })
    // todo optionsCanBreakVariadicArg
    const { suggestions, default: defaultValue } = arg
    // todo expect all props, handle type
    if (suggestions) {
        completions.push(
            ...compact(
                suggestions.map(suggestion =>
                    figSuggestionToCompletion(suggestion, documentInfo, {
                        // todo(codebase) def check
                        filterStrategy: arg.filterStrategy,
                    }),
                ),
            ),
        )
    }
    if (!documentInfo.includeCached) {
        completions.push(...(await templateOrGeneratorsToCompletion(arg, documentInfo)))
    }
    completions.push(...((await figGeneratorScriptToCompletions(arg, documentInfo)) ?? []))
    if (defaultValue) {
        for (const completion of completions) {
            if (typeof completion?.label !== 'object') continue
            // todo comp name?
            if (completion.label.label === defaultValue) completion.label.description = 'DEFAULT'
        }
    }
    return compact(completions)
}

// imo specOptions is more memorizable rather than commandOptions
const specOptionsToVscodeCompletions = (subcommand: Fig.Subcommand, documentInfo: DocumentInfo) => {
    return compact(getNormalizedSpecOptions(subcommand)?.map(option => parseOptionToCompletion(option, documentInfo)) ?? [])
}

// todo hide commands
const parseOptionToCompletion = (option: Fig.Option, info: DocumentInfo): CompletionItem | undefined => {
    if (!doSuggestFiltering(option, info)) return
    let { args, isRequired, isRepeatable = false, requiresSeparator: seperator = false, dependsOn, exclusiveOn } = option

    if (seperator === true) seperator = '='
    if (seperator === false) seperator = ''

    const usedOptionsNames = info.usedOptions
    const currentOptionsArr = ensureArray(option.name)

    const optionUsedCount = usedOptionsNames.filter(name => currentOptionsArr.includes(name)).length
    if (isRepeatable === false && optionUsedCount > 0) return
    if (typeof isRepeatable === 'number' && optionUsedCount >= isRepeatable) return

    if (dependsOn && !dependsOn.every(name => usedOptionsNames.includes(name))) return
    if (exclusiveOn?.some(name => usedOptionsNames.includes(name))) return

    const optionsRender = currentOptionsArr.join(', ')
    const completion = figBaseSuggestionToVscodeCompletion(option, optionsRender, { ...info, sortTextPrepend: 'd', assignGlobalCompletionIcon: true })
    if (!completion) return
    ;(completion.label as CompletionItemLabel).detail = isRequired ? 'REQUIRED' : getArgPreviewFromOption(option)

    const typedOption = info.currentPartValue ?? ''
    const insertOption = Array.isArray(option.name)
        ? // option.name /* filter gracefully */
          //       .map(name => [name, name.indexOf(typedOption)] as const)
          //       .sort((a, b) => a[1] - b[1])
          //       .filter(([, index]) => index !== -1)?.[0]?.[0] || option.name[0]
          option.name.find(name => name.toLowerCase().includes(typedOption.toLowerCase())) || option.name[0]
        : option.name

    completion.insertText ??= insertOption + seperator

    if (!seperator) {
        addInsertSpaceToCompletion(completion, !!args && ensureArray(args).some(x => !x.isOptional), info)
    }

    return completion
}

// #endregion

// #region Completion helpers
const doSuggestFiltering = ({ name, filterStrategy }: Pick<Fig.Subcommand, 'name' | 'filterStrategy'>, { currentPartValue }: DocumentInfo) => {
    if (!filterStrategy || filterStrategy === 'default') filterStrategy = globalSettings.defaultFilterStrategy
    if (filterStrategy === 'fuzzy') {
        // let vscode handle the filtering, it knows how to do that
        return true
    }
    return ensureArray(name).some(x => x.startsWith(currentPartValue))
}

const addInsertSpaceToCompletion = (completion: CompletionItem, hasArgs: boolean, info: DocumentInfo) => {
    const { insertSpace } = globalSettings
    const spaceShouldBeInserted = insertSpace === 'always' || (hasArgs && insertSpace === 'ifSubcommandOrOptionTakeArguments')
    if (!spaceShouldBeInserted) return

    const nextCharsOffset = info.currentPartOffset + info.currentPartValue.length
    const nextTwoChars = info.inputString.slice(nextCharsOffset, nextCharsOffset + 2)

    const insertSpaceType = nextTwoChars === ' '.repeat(2) ? 'double' : !nextTwoChars.startsWith(' ') ? 'single' : undefined

    const { insertText } = completion
    if (
        insertSpaceType &&
        (typeof insertText !== 'object' ||
            // for now, there is only {cursor} placeholder
            !insertText.value.includes('$1'))
    ) {
        if (insertSpaceType === 'single') {
            if (typeof insertText === 'object') insertText.value += ' '
            else completion.insertText += ' '
        }
        completion.command = {
            command: ACCEPT_COMPLETION_COMMAND,
            arguments: [{ cursorRight: insertSpaceType === 'double' }],
            title: '',
        }
    }
}

// todo to options, introduce flattened lvl
const getFilesSuggestions = async (cwd: Uri, stringContents: string, includeType?: FileType) => {
    const folderPath = stringContents.split('/').slice(0, -1).join('/')
    let filesList: [name: string, type: FileType][]
    try {
        filesList = await workspace.fs.readDirectory(Uri.joinPath(cwd, folderPath))
    } catch {
        filesList = []
    }
    // todo add .. if not going outside of workspace
    return compact(
        filesList.map(([name, type]): Fig.Suggestion | undefined => {
            if (includeType && !(type & includeType)) return undefined
            const isDir = type & FileType.Directory
            return {
                name: isDir ? `${name}/` : name,
                type: isDir ? 'folder' : 'file',
                // display by default folders above files to align with default explorer look
                priority: isDir ? 71 : 70,
            }
        }),
    )
}

const getGlobalCompletionIcon = (specName: string) => {
    const templateName = Object.entries(specGlobalIconMap).find(([, specs]) => specs.includes(specName))?.[0]
    if (!templateName) return
    return templateName.replaceAll('{name}', specName)
}

const getArgPreviewFromOption = ({ args }: Fig.Option) => {
    const argsPreview =
        args &&
        ensureArray(args)
            .map(({ name }) => name)
            .filter(name => name?.trim())
            .join(' ')
    if (!argsPreview) return
    return ` ${argsPreview}`
}
// #endregion

// #region Simple utils
const getExtensionSetting = <T = any>(key: string, document?: TextDocument) => {
    return workspace.getConfiguration(CONTRIBUTION_PREFIX, document).get(key) as T
}

const getCwdUri = ({ uri }: Pick<TextDocument, 'uri'>) => {
    // todo (easy) parse cd commands
    const allowSchemes = ['file', 'vscode-vfs']
    if (allowSchemes.includes(uri.scheme)) return Uri.joinPath(uri, '..')
    const firstWorkspace = workspace.workspaceFolders?.[0]
    return firstWorkspace?.uri
}

const getNormalizedSpecOptions = ({ options }: Fig.Subcommand) => {
    if (!options) return
    const optionsUniq = _.uniqBy([...options].reverse(), value => value.name.toString())
    return optionsUniq
}

const getCompletingSpec = (specName: string | Fig.LoadSpec): Fig.Spec | undefined => {
    // todo
    if (typeof specName !== 'string') return
    return ALL_LOADED_SPECS.find(({ name }) => ensureArray(name).includes(specName))
}

// todo it just works
const fixEndingPos = (inputString: string, offset: number, contents: string) => {
    const char = inputString[offset]
    const endingOffset = offset + contents.length
    return ["'", '"'].includes(char) ? endingOffset + 2 : endingOffset
}
const fixPathArgRange = (inputString: string, startOffset: number, rangePos: [Position, Position]): [Position, Position] => {
    const char = inputString[startOffset]
    return ["'", '"'].includes(char) ? [rangePos[0].translate(0, 1), rangePos[1].translate(0, -1)] : rangePos
}

export const guessOptionSimilarName = (invalidName: string, validNames: string[]) => {
    // dont even try for flags like -b
    if (/^-[^-]/.exec(invalidName)) return
    return validNames.find(validName => {
        // todo support options
        if (/^-[^-]/.exec(validName)) return
        const mainComparingName = invalidName.length > validName.length ? invalidName : validName
        const otherComparingName = invalidName.length > validName.length ? validName : invalidName
        let diffChars = mainComparingName.length - otherComparingName.length
        // actually always 2 at start
        let sameChars = 0
        for (const i in [...mainComparingName]) {
            if (mainComparingName[i] === otherComparingName[i]) sameChars++
            else diffChars++
        }
        if (sameChars >= 4 && diffChars <= 2) return validName
    })
}
// #endregion

// #region Command parsing
const commandPartIsOption = (contents: string | undefined): boolean => contents?.startsWith('-') ?? false

const getAllCommandsFromString = (inputString: string) => {
    const commandsParts = (parse(inputString) as any[]).reduce<CommandsParts>(
        (prev, parsedPart: CommandPartParseTuple | { op: string; index: number }) => {
            if (Array.isArray(parsedPart)) {
                const last = prev.slice(-1)[0]!.parts
                last.push(parsedPart)
            } else {
                // op end position, it introduces start of new command
                prev.push({ parts: [], start: parsedPart.index + parsedPart.op.length, op: parsedPart.op })
            }
            return prev
        },
        // todo(codebase) investigate typing compl
        [{ parts: [], start: 0, op: '' }],
    )
    return commandsParts
}

interface ParseCommandStringResult {
    allParts: CommandPartTuple[]
    currentPartValue: string
    currentPartIsOption: boolean
    /** offset in input string */
    currentPartOffset: number
    currentPartIndex: number
}

const getIsPartShouldBeIgnored = ({ op }: CommandsParts[number]) => {
    const isRedirectPart = ['<', '>'].some(x => op.includes(x))
    return isRedirectPart
}

// todo parserDirectives
export const parseCommandString = (inputString: string, stringPos: number, stripCurrentValue: boolean): ParseCommandStringResult | undefined => {
    const allCommandsFromString = getAllCommandsFromString(inputString)
    let currentCommandParts!: CommandsParts[number]
    for (const commandParts of allCommandsFromString) {
        if (commandParts.start <= stringPos) {
            currentCommandParts = commandParts
        } else {
            break
        }
    }
    // todo provide file definition links
    if (getIsPartShouldBeIgnored(currentCommandParts)) return
    // needs currentCommandPartEnd
    let currentPartIndex = -1
    let currentPartOffset = 0
    let currentPartValue = ''
    let isInsidePart = false
    for (const [i, currentCommandPart] of currentCommandParts.parts.entries()) {
        if (currentCommandPart?.[1] <= stringPos) {
            currentPartIndex = i
            isInsidePart = stringPos <= currentCommandPart[1] + currentCommandPart[0].length
            currentPartOffset = currentCommandPart[1]
            currentPartValue = stripCurrentValue ? currentCommandPart[0].slice(0, stringPos - currentCommandPart?.[1]) : currentCommandPart[0]
        } else {
            break
        }
    }
    // always add '' part for positions like ' |' or 'spec | --option'
    if (!isInsidePart && inputString[stringPos - 1] === ' ') {
        // previous part exists, let's distinguish it
        currentPartOffset = stringPos
        currentPartValue = ''
        currentPartIndex++
        currentCommandParts.parts.splice(currentPartIndex, 0, [currentPartValue, currentPartOffset])
    }
    if (currentPartIndex === -1) {
        currentPartIndex = 0
        // align data with current* variables
        currentCommandParts.parts.push(['', 0])
    }
    return {
        allParts: currentCommandParts.parts.map(([c, offset]) => [c, offset, commandPartIsOption(c)] as CommandPartTuple),
        currentPartIndex,
        currentPartValue,
        currentPartOffset,
        currentPartIsOption: commandPartIsOption(currentPartValue),
    }
}

const getDocumentParsedResult = (
    _document: TextDocument,
    stringContents: string,
    realPos: Position,
    cursorStringOffset: number,
    startPos: Position,
    options: { stripCurrentValue: boolean; includeCached: boolean },
): DocumentInfo | undefined => {
    const parseCommandResult = parseCommandString(stringContents, cursorStringOffset, options.stripCurrentValue)
    if (!parseCommandResult) return
    const { allParts, currentPartIndex, currentPartValue, currentPartOffset, currentPartIsOption } = parseCommandResult

    /** can be specName */
    const preCurrentValue = allParts[currentPartIndex - 1]?.[0]
    const nextPartValue = allParts[currentPartIndex + 1]?.[0]
    const previousPartIsOptionWithArg = commandPartIsOption(preCurrentValue) && !currentPartIsOption
    const currentPartIsOptionWithArg = nextPartValue && !commandPartIsOption(nextPartValue) && currentPartIsOption
    const completingOptionFull: DocumentInfo['parsedInfo']['completingOptionFull'] = previousPartIsOptionWithArg
        ? [currentPartIndex - 1, currentPartIndex]
        : currentPartIsOptionWithArg
        ? [currentPartIndex, currentPartIndex + 1]
        : undefined
    return {
        _document,
        realPos,
        startPos,
        inputString: stringContents,
        specName: allParts[0][0],
        currentPartValue,
        usedOptions: allParts.filter(([content], index) => commandPartIsOption(content) && index !== currentPartIndex).map(([content]) => content),
        currentPartOffset,
        currentPartIndex,
        allParts,
        includeCached: options.includeCached,
        currentPartIsOption,
        parsedInfo: {
            completingOptionValue: previousPartIsOptionWithArg
                ? {
                      paramName: preCurrentValue,
                      currentEnteredValue: currentPartValue!,
                  }
                : undefined,
            // holds option name + option value, used for things like hover to hover them together
            completingOptionFull,
        },
    }
}
// #endregion

const figBaseSuggestionToHover = (
    { description }: Fig.BaseSuggestion,
    { type = '', range }: { type: Fig.SuggestionType | '' | undefined; range?: [Position, Position] },
): Hover | undefined => {
    if (!description) return
    const text = type && `(${type}) `
    return {
        contents: [new MarkdownString().appendText(text).appendMarkdown(description)],
        range: range && new Range(range[0], range[1]),
    }
}

const getNotAllowedSpecContextReason = (specName: string, document: TextDocument) => {
    const defaultReason = "Command can't be used in this context"
    for (const { isSpecCanBeUsed } of registeredLanguageProviders) {
        if (!isSpecCanBeUsed) continue
        try {
            const specCanBeUsedReason = isSpecCanBeUsed(specName, document.uri)
            if (specCanBeUsedReason === true) continue
            if (specCanBeUsedReason === false) {
                return defaultReason
            }
            return specCanBeUsedReason
        } catch (err) {
            console.error(err)
        }
    }
}

type LintProblemType = 'commandName' | 'option' | 'noArgInput' | 'commandNotAllowedContext'
type LintProblem = {
    type: LintProblemType
    range: [Position, Position]
    message: string
    code?: string
}

type CustomCompletionItem = CompletionItem & { shouldBeCached?: boolean }

// can also be refactored to try/finally instead, but d require extra indent
interface ParseCollectedData {
    specName?: string
    argSignatureHelp?: Fig.Arg
    hoverRange?: [Position, Position]
    currentOption?: Fig.Option
    currentSubcommand?: Fig.Option

    currentPart?: CommandPartTuple
    currentPartIndex?: number
    currentPartRange?: [Position, Position]

    collectedCompletions?: CustomCompletionItem[]
    collectedCompletionsPromise?: Promise<CustomCompletionItem[]>[]
    collectedCompletionsIncomplete?: boolean

    lintProblems?: LintProblem[]

    currentFilePathPart?: [...CommandPartTuple, Range]
    filePathParts?: [...CommandPartTuple, Range][]

    partsSemanticTypes?: [Range, SemanticLegendType][]
}

// rough parser limitation: "--test" is always treated & validated is an option
// todo doesn't support parserDirectives at all
const fullCommandParse = (
    document: TextDocument,
    inputRange: Range,
    _position: Position,
    collectedData: ParseCollectedData,
    // needs cleanup
    parsingReason: 'completions' | 'signatureHelp' | 'hover' | 'lint' | 'pathParts' | 'semanticHighlight',
    {
        includeCachedCompletion,
        includeSpecContextLint,
    }: {
        includeCachedCompletion?: boolean
        includeSpecContextLint?: boolean
    } = {},
    // TODO these come from API
    // languageSupportInfo: Pick<RegisterLanguageSupportOptions, ''>
): undefined => {
    const inputText = document.getText(inputRange)
    const startPos = inputRange.start
    const stringPos = _position.character - startPos.character
    const documentInfo = getDocumentParsedResult(document, inputText, _position, stringPos, startPos, {
        stripCurrentValue: parsingReason === 'completions',
        includeCached: includeCachedCompletion ?? false,
    })
    if (!documentInfo) return
    let { specName, allParts, currentPartValue, currentPartIndex, currentPartIsOption } = documentInfo
    /* these requestes are not interested of gathering information of requested position */
    const inspectOnlyAllParts = oneOf(parsingReason, 'lint', 'semanticHighlight', 'pathParts')

    // avoid using positions to avoid potential .translate() crashes
    if (parsingReason !== 'completions') {
        documentInfo.realPos = undefined
        documentInfo.startPos = undefined
    }
    const partToRange = (index: number) => {
        const [contents, offset] = allParts[index]
        return [startPos.translate(0, offset), startPos.translate(0, fixEndingPos(inputText, offset, contents))] as [Position, Position]
    }

    collectedData.partsSemanticTypes = []
    collectedData.currentPartIndex = currentPartIndex
    collectedData.hoverRange = partToRange(currentPartIndex)
    collectedData.lintProblems = []
    collectedData.filePathParts = []
    collectedData.collectedCompletions = []
    collectedData.collectedCompletionsPromise = []
    collectedData.specName = specName
    const addCompletions = (getItems: () => CompletionItem[] | undefined) => {
        if (parsingReason !== 'completions') return
        collectedData.collectedCompletions!.push(...(getItems() ?? []))
    }
    const addPromiseCompletions = (getItems: () => Promise<CompletionItem[]> | undefined) => {
        if (parsingReason !== 'completions') return
        const items = getItems()
        if (!items) return
        collectedData.collectedCompletionsPromise!.push(items)
    }

    addCompletions(() => {
        const textBeforePosition = allParts
            .slice(0, currentPartIndex)
            .map(([content]) => content)
            .join(' ')
        const collectedSuggestions: Fig.Suggestion[] = []
        for (const [commandString, suggestions] of Object.entries(globalSettings.mixins)) {
            if (textBeforePosition === commandString) {
                collectedSuggestions.push(...suggestions)
                break
            }
        }
        return compact(collectedSuggestions.map(suggestion => figSuggestionToCompletion(suggestion, { ...documentInfo, kind: CompletionItemKind.Snippet })))
    })

    const setSemanticType = (index: number, type: SemanticLegendType) => {
        if (parsingReason !== 'semanticHighlight') return
        collectedData.partsSemanticTypes!.push([new Range(...partToRange(index)), type])
    }
    setSemanticType(0, 'command')
    // is in command name
    if (currentPartIndex === 0) {
        addCompletions(() => getRootSpecCompletions(documentInfo))
        if (parsingReason === 'hover') {
            const spec = getCompletingSpec(specName)
            collectedData.currentSubcommand = spec && getFigSubcommand(spec)
        }
        if (!inspectOnlyAllParts) return
    }

    if (globalSettings.ignoreClis.includes(specName)) return
    if (parsingReason === 'lint' && includeSpecContextLint) {
        const notAllowedContextReason = getNotAllowedSpecContextReason(specName, document)
        if (notAllowedContextReason) {
            collectedData.lintProblems.push({
                message: notAllowedContextReason,
                range: partToRange(0),
                type: 'commandNotAllowedContext',
            })
        }
    }
    const spec = getCompletingSpec(specName)
    if (!spec) {
        // report commandName lint problem
        if (parsingReason === 'lint' && specName.trim() !== '') {
            collectedData.lintProblems.push({
                message: `Unknown command ${specName}`,
                range: partToRange(0),
                type: 'commandName',
            })
        }
        return
    }
    const figRootSubcommand = getFigSubcommand(spec)

    const getIsPathPart = (arg: Fig.Arg) => {
        const isPathTemplate = ({ template }: { template?: Fig.Template }): boolean =>
            !!template && ensureArray(template).filter(templ => oneOf(templ, 'folders', 'filepaths')).length > 0
        return isPathTemplate(arg) || ensureArray(arg.generators ?? []).some(gen => isPathTemplate(gen))
    }
    const changeCollectedDataPath = (arg: Fig.Arg, i: number) => {
        const part = allParts[i]
        // todo duplication
        collectedData.currentFilePathPart = getIsPathPart(arg) ? [...part, new Range(...fixPathArgRange(inputText, part[1], partToRange(i)))] : undefined
    }
    const addPossiblyPathPart = (i: number, args: Fig.Arg[] | Fig.Arg | undefined) => {
        if (!args) return
        const isPathPart = ensureArray(args).some(arg => getIsPathPart(arg))
        if (!isPathPart) return
        const part = allParts[i]
        collectedData.filePathParts!.push([...part, new Range(...fixPathArgRange(inputText, part[1], partToRange(i)))])
    }

    const { completingOptionValue: completingParamValue, completingOptionFull } = documentInfo.parsedInfo
    const goingToSuggest = {
        options: true,
        subcommands: true,
    }
    /** current subcommand, can be changed between tokens */
    let subcommand = figRootSubcommand
    let argMetCount = 0

    const getSubcommandOption = (name: string) =>
        subcommand.options?.find(({ name: optName }) => (Array.isArray(optName) ? optName.includes(name) : optName === name))
    // todo resolv
    const alreadyUsedOptions = [] as string[]
    collectedData.currentPart = allParts[currentPartIndex]
    collectedData.currentPartRange = partToRange(currentPartIndex)
    // iterate on each token
    for (const [_iteratingPartIndex, [partContents, _partStartPos, partIsOption]] of (!inspectOnlyAllParts
        ? allParts.slice(1, currentPartIndex)
        : allParts.slice(1)
    ).entries()) {
        const partIndex = _iteratingPartIndex + 1
        if (partIsOption) {
            if (partContents === '--') {
                goingToSuggest.options = false
                goingToSuggest.subcommands = false
            }
            let optionProblem:
                | {
                      message: string
                      code: string
                  }
                | undefined
            // don't be too annoying for -- and -
            if (!inspectOnlyAllParts || /^--?$/.exec(partContents)) continue
            // todo arg
            if (getSubcommandOption(partContents)?.isDangerous) setSemanticType(partIndex, 'dangerous')
            else setSemanticType(partIndex, 'option')
            if (subcommand.parserDirectives?.optionArgSeparators) continue
            // below: lint option
            if (!subcommand.options || subcommand.options.length === 0) {
                optionProblem = {
                    message: "Command doesn't take options here",
                    code: 'noOptionsInput',
                }
            } else {
                // todo what to do with args starting with - or -- ?
                // todo is varaibid
                const option = getSubcommandOption(partContents)
                if (!option) {
                    const { options } = subcommand
                    const guessedOptionName =
                        options &&
                        guessOptionSimilarName(
                            partContents,
                            options.flatMap(({ name }) => ensureArray(name)),
                        )
                    optionProblem = {
                        message: `Unknown option ${partContents}`,
                        code: 'unknownOption',
                    }
                    if (guessedOptionName) optionProblem.message += ` Did you mean ${guessedOptionName}?`
                } else if (alreadyUsedOptions.includes(partContents)) {
                    optionProblem = {
                        message: `${partContents} option was already used [here]`,
                        code: 'alreadyUsedOption', // probably should be changed
                    }
                }
            }
            if (optionProblem) {
                collectedData.lintProblems.push({
                    ...optionProblem,
                    range: partToRange(partIndex),
                    type: 'option',
                })
            }
            alreadyUsedOptions.push(partContents)
        } else {
            const subcommandSwitch = subcommand.subcommands?.find(subcommand => ensureArray(subcommand.name).includes(partContents))
            if (subcommandSwitch) {
                subcommand = subcommandSwitch
                setSemanticType(partIndex, 'subcommand')
                argMetCount = 0
            } else if (allParts[partIndex - 1][2] && getSubcommandOption(allParts[partIndex - 1][0])?.args) {
                setSemanticType(partIndex, 'option-arg')
                addPossiblyPathPart(partIndex, getSubcommandOption(allParts[partIndex - 1][0])?.args)
            } else if (subcommand.args) {
                setSemanticType(partIndex, 'arg')
                addPossiblyPathPart(partIndex, subcommand.args)
                argMetCount++
                // subcommand.requiresSubcommand
                const arg = ensureArray(subcommand.args)[0]
                // note: doesn't support deprecated (isModule)
                if (!arg.isVariadic && (arg.isCommand || arg.loadSpec)) {
                    // switch spec
                    let newSpec: Fig.Spec | undefined
                    if (arg.isCommand) newSpec = getCompletingSpec(partContents)
                    else if (arg.loadSpec) newSpec = getCompletingSpec(arg.loadSpec)
                    // we failed to load unknown spec now its nothing
                    if (!newSpec) return
                    argMetCount = 0
                    subcommand = newSpec
                }
                // validate arg
            } else {
                collectedData.lintProblems.push({
                    message: `${subcommand.name} doesn't take argument here`,
                    range: partToRange(partIndex),
                    type: 'noArgInput',
                })
            }
        }
    }

    // todo make it easier to see & understand
    if (inspectOnlyAllParts) return
    if (/* !currentPartIsOption */ true) {
        for (const arg of ensureArray(subcommand.args ?? [])) {
            if (!arg.isVariadic && argMetCount !== 0) continue
            addPromiseCompletions(() => figArgToCompletions(arg, documentInfo))
            changeCollectedDataPath(arg, currentPartIndex)
            if (!currentPartIsOption) collectedData.argSignatureHelp = arg
            // todo is that right? (stopping at first one)
            break
        }
        const { subcommands, additionalSuggestions } = subcommand
        if (parsingReason === 'hover' && !currentPartIsOption && subcommands) {
            collectedData.currentSubcommand = subcommands.find(({ name }) => ensureArray(name).includes(currentPartValue))
        }
        if (goingToSuggest.subcommands) {
            if (subcommands) addCompletions(() => figSubcommandsToVscodeCompletions(subcommands, documentInfo))
            if (additionalSuggestions)
                addCompletions(() =>
                    compact(
                        additionalSuggestions.map(suggest =>
                            figSuggestionToCompletion(suggest, { ...documentInfo, kind: CompletionItemKind.Event, sortTextPrepend: 'c' }),
                        ),
                    ),
                )
        }
    }

    const options = getNormalizedSpecOptions(subcommand)
    if (options) {
        // hack to not treat location in option name as arg position
        if (parsingReason === 'completions') currentPartValue = currentPartValue.slice(0, stringPos)
        // todo maybe use sep-all optm?
        let patchedDocumentInfo = documentInfo
        // todo1 refactor to forof
        // parserDirectives?
        const { usedOptions } = documentInfo
        const optionWithSep = findCustomArray(options, ({ requiresSeparator, name }) => {
            if (!requiresSeparator) return
            const sep = requiresSeparator === true ? '=' : requiresSeparator
            for (const option of usedOptions) {
                const sepIndex = option.indexOf(sep)
                if (sepIndex === -1) continue
                // pushing fixed variants along with existing incorrect
                usedOptions.push(option.slice(0, sepIndex))
            }
            const sepIndex = currentPartValue.indexOf(sep)
            if (sepIndex === -1) return
            const userParamName = currentPartValue.slice(0, sepIndex)
            if (!ensureArray(name).includes(userParamName)) return
            const userParamValue = currentPartValue.slice(sepIndex + 1)
            patchedDocumentInfo = { ...documentInfo, currentPartValue: userParamValue }
            return [userParamName, userParamValue] as const
        })
        const currentOptionValue =
            optionWithSep || (completingParamValue ? [completingParamValue.paramName, completingParamValue.currentEnteredValue] : undefined)

        const completingParamName =
            currentOptionValue?.[0] ?? completingParamValue?.paramName ?? (commandPartIsOption(currentPartValue) ? currentPartValue : undefined)
        if (optionWithSep) goingToSuggest.options = false
        if (completingParamName) collectedData.currentOption = options.find(specOption => ensureArray(specOption.name).includes(completingParamName))
        // todo git config --global
        if (completingOptionFull) {
            const [optionIndex, argIndex] = completingOptionFull
            const optionHasArg = !!getSubcommandOption(allParts[optionIndex][0])?.args
            const endPos = partToRange(argIndex)[1]
            if (optionHasArg) collectedData.hoverRange = [partToRange(optionIndex)[0], endPos]
        }

        patchedDocumentInfo = { ...patchedDocumentInfo, usedOptions }
        if (currentOptionValue) {
            const completingOption = getSubcommandOption(currentOptionValue[0])
            let { args } = completingOption ?? {}
            // todo
            let arg = Array.isArray(args) ? args[0] : args
            if (arg) {
                collectedData.argSignatureHelp = arg
                changeCollectedDataPath(arg, currentPartIndex)
                if (!arg.isOptional) {
                    // make sure only arg completions are showed
                    // todo r
                    collectedData.collectedCompletions.splice(0, collectedData.collectedCompletions.length)
                    goingToSuggest.options = false
                }
                addPromiseCompletions(() => figArgToCompletions(arg!, patchedDocumentInfo))
            }
        }

        if (goingToSuggest.options) addCompletions(() => specOptionsToVscodeCompletions(subcommand, patchedDocumentInfo))
    }

    collectedData.collectedCompletionsIncomplete = true
}

type DocumentWithPos = {
    document: TextDocument
    position: Position
}

const getAllCommandLocations = (document: TextDocument, inputRanges: Range[]) => {
    const outputRanges: Range[] = []
    for (const range of inputRanges ?? []) {
        const allCommands = getAllCommandsFromString(document.getText(range)).filter(part => !getIsPartShouldBeIgnored(part))
        const stringStartPos = range.start
        outputRanges.push(
            ...compact(
                allCommands.map(({ parts, start }) => {
                    const firstPart = parts[0]
                    if (!firstPart) return
                    const [lastContents, endOffset] = parts.at(-1)!
                    const startPos = stringStartPos.translate(0, start)
                    return new Range(startPos, stringStartPos.translate(0, endOffset + lastContents.length))
                }),
            ),
        )
    }
    return outputRanges
}

// lifted for type inferrence
const semanticLegendTypes = ['command', 'subcommand', 'arg', 'option', 'option-arg', 'dangerous'] as const
type SemanticLegendType = typeof semanticLegendTypes[number]

const ACCEPT_COMPLETION_COMMAND = `_${CONTRIBUTION_PREFIX}.acceptCompletion`

const registerCommands = () => {
    commands.registerCommand(ACCEPT_COMPLETION_COMMAND, async ({ cursorRight } = {}) => {
        if (cursorRight) await commands.executeCommand('cursorRight')
        if (oneOf(globalSettings.autoParameterHints, 'afterSuggestionSelect', 'afterSpace')) commands.executeCommand('editor.action.triggerSuggest')
        commands.executeCommand('editor.action.triggerParameterHints')
    })
}

const initSettings = () => {
    const updateGlobalSettings = () => {
        globalSettings.mixins = getExtensionSetting('mixins')
        globalSettings.ignoreClis = getExtensionSetting('ignoreClis')
        globalSettings.useFileIcons = getExtensionSetting('useFileIcons')
        globalSettings.insertSpace = getExtensionSetting('insertSpace')
        globalSettings.autoParameterHints = getExtensionSetting('autoParameterHints')
        globalSettings.defaultFilterStrategy = getExtensionSetting('fuzzySearch') ? 'fuzzy' : 'prefix'

        globalSettings.scriptEnable = getExtensionSetting('scriptsGenerators.enable')
        globalSettings.scriptAllowList = getExtensionSetting('scriptsGenerators.allowList')
        globalSettings.scriptTimeout = getExtensionSetting('scriptsGenerators.scriptTimeout')
    }
    updateGlobalSettings()
    workspace.onDidChangeConfiguration(({ affectsConfiguration }) => {
        if (affectsConfiguration(CONTRIBUTION_PREFIX)) updateGlobalSettings()
    })
}

const getBestLanguageProvider = (document: TextDocument) => {
    let matchedProvider: RegisteredLanguageProvider | undefined
    let bestMatchedScore = 0
    for (const provider of registeredLanguageProviders) {
        const score = languages.match(provider.selector, document)
        if (score === 0 || score < bestMatchedScore) continue
        matchedProvider = provider
        bestMatchedScore = score
        // best possible score
        if (score === 10) break
    }
    return matchedProvider
}

const registerLanguageSupport: API['registerLanguageSupport'] = (selector, options, featureControl = {}) => {
    const disposables: Disposable[] = []
    registeredLanguageProviders.push({ selector, ...options, ...featureControl })
    registerLanguageProviders(selector, options, featureControl, disposables)

    languageSupportRegisteredEvent.fire()

    return { disposables }
}

const registerLanguageProviders = (
    documentSelector: DocumentSelector,
    options: RegisterLanguageSupportOptions,
    featureControl: FeatureControl,
    disposables: Disposable[],
) => {
    const { provideSingleLineRangeFromPosition } = options
    const COMPLETION_TRIGGER_CHARACTERS = [
        ' ',
        '-',
        // file path
        '/',
        // file ext
        '.',
        // common option separators
        '=',
        ':',
        // common delimiter between values in option arg generators
        ',',
    ]

    const completionsCache: Map<TextDocument, CompletionItem[] | undefined> = new Map()
    const completionProvider = languages.registerCompletionItemProvider(
        documentSelector,
        {
            async provideCompletionItems(document, position, token, context) {
                // let api to dynamically disable completion provider
                const { enableCompletionProvider } = featureControl
                if (enableCompletionProvider === false) return

                let cachedCompletions: CompletionItem[] | undefined
                if (context.triggerKind === CompletionTriggerKind.TriggerForIncompleteCompletions) {
                    cachedCompletions = completionsCache.get(document)
                }

                const commandRange = await provideSingleLineRangeFromPosition(document, position)
                if (!commandRange) return
                const collectedData: ParseCollectedData = {}
                fullCommandParse(document, commandRange, position, collectedData, 'completions', { includeCachedCompletion: !!cachedCompletions })
                const { collectedCompletions = [], collectedCompletionsPromise = [], collectedCompletionsIncomplete } = collectedData
                const completionsFromPromise = await Promise.all(collectedCompletionsPromise)
                const completions = [...collectedCompletions, ...completionsFromPromise.flat(1)]

                if (!cachedCompletions) {
                    completionsCache.set(
                        document,
                        completions.filter(({ shouldBeCached }) => shouldBeCached),
                    )
                }
                const processCompletions = (typeof enableCompletionProvider === 'object' && enableCompletionProvider.processCompletions) || (x => x)
                return {
                    items: processCompletions([...completions, ...(cachedCompletions ?? [])], { specName: collectedData.specName! }),
                    isIncomplete: collectedCompletionsIncomplete,
                }
            },
        },
        ...COMPLETION_TRIGGER_CHARACTERS,
    )
    disposables.push(completionProvider)

    const { disableProviders = [] } = featureControl

    const helpProvider = languages.registerSignatureHelpProvider(
        documentSelector,
        {
            async provideSignatureHelp(document, position, token, context) {
                if (disableProviders.includes('signatureHelp')) return
                // todo use cached result
                const commandRange = await provideSingleLineRangeFromPosition(document, position)
                if (!commandRange) return
                const collectedData: ParseCollectedData = {}
                fullCommandParse(document, commandRange, position, collectedData, 'signatureHelp')
                const { argSignatureHelp: arg } = collectedData
                if (!arg) return
                let hint = arg.description ?? arg.name ?? 'argument'
                // todo it always feel like it asks for something
                if (arg.isOptional) hint += '?'
                if (arg.default) hint += ` (${arg.default})`
                return {
                    activeParameter: 0,
                    activeSignature: 0,
                    signatures: [
                        {
                            label: hint,
                            parameters: [
                                {
                                    label: hint,
                                },
                            ],
                        },
                    ],
                }
            },
        },
        '=',
    )
    disposables.push(helpProvider)

    const hoverProvider = languages.registerHoverProvider(documentSelector, {
        async provideHover(document, position) {
            if (disableProviders.includes('hover')) return
            // todo use cached result?
            const commandRange = await provideSingleLineRangeFromPosition(document, position)
            if (!commandRange) return
            const collectedData: ParseCollectedData = {}
            fullCommandParse(document, commandRange, position, collectedData, 'hover')
            const { argSignatureHelp: arg, currentOption, currentSubcommand, hoverRange, currentPartIndex } = collectedData
            const someSuggestion = currentSubcommand || currentOption || arg
            let type: Fig.SuggestionType | undefined
            if (arg) type = 'arg'
            if (currentOption) type = 'option'
            // don't display (subcommand) for root command
            if (currentSubcommand && currentPartIndex !== 0) type = 'subcommand'
            if (!someSuggestion) return
            const hover = figBaseSuggestionToHover(someSuggestion, { type, range: hoverRange })
            return hover
        },
    })
    disposables.push(hoverProvider)

    const pathStringToUri = (document: TextDocument, contents: string) => {
        const cwdUri = getCwdUri(document)
        if (!cwdUri) return
        return Uri.joinPath(cwdUri, contents)
    }

    const getFilePathPart = async ({ document, position }: DocumentWithPos, checkFileExistence: boolean) => {
        const commandRange = await provideSingleLineRangeFromPosition(document, position)
        if (!commandRange) return
        const collectedData: ParseCollectedData = {}
        fullCommandParse(document, commandRange, position, collectedData, 'signatureHelp')
        let { currentFilePathPart } = collectedData
        if (!currentFilePathPart) return
        const uri = pathStringToUri(document, currentFilePathPart[0])
        if (!uri) return
        return {
            range: currentFilePathPart[3],
            contents: currentFilePathPart[0],
            // uri of existing file
            uri,
            fileExists: checkFileExistence
                ? workspace.fs.stat(uri).then(
                      () => true,
                      () => false,
                  )
                : undefined,
        }
    }

    const defProvider = languages.registerDefinitionProvider(documentSelector, {
        async provideDefinition(document, position, token) {
            if (disableProviders.includes('definition')) return
            const { contents, uri, range } = (await getFilePathPart({ document, position }, true)) ?? {}
            if (!contents) return
            return [
                {
                    targetRange: new Range(new Position(0, 0), new Position(1000, 1000)),
                    targetUri: uri,
                    // todo use inner
                    originSelectionRange: range,
                } as LocationLink,
            ]
        },
    })
    disposables.push(defProvider)

    if (disableProviders.includes('rename')) {
        const renameProvider = languages.registerRenameProvider(documentSelector, {
            async prepareRename(document, position, token) {
                const { range, fileExists } = (await getFilePathPart({ document, position }, true)) ?? {}
                if (!range) throw new Error('You cannot rename this element')
                if (!(await fileExists)) throw new Error("Renaming file doesn't exist")
                return range
            },
            async provideRenameEdits(document, position, newName, token) {
                const { range, uri, fileExists } = (await getFilePathPart({ document, position }, true)) ?? {}
                if (!uri || !(await fileExists)) return
                const edit = new WorkspaceEdit()
                edit.set(document.uri, [{ range: range!, newText: newName }])
                edit.renameFile(uri, Uri.joinPath(getCwdUri({ uri })!, newName))
                return edit
            },
        })
        disposables.push(renameProvider)
    }

    const selectionProvider = languages.registerSelectionRangeProvider(documentSelector, {
        async provideSelectionRanges(document, positions, token) {
            if (disableProviders.includes('rangeSelection')) return
            const ranges: SelectionRange[] = []
            for (const position of positions) {
                const commandRange = await provideSingleLineRangeFromPosition(document, position)
                if (!commandRange) continue
                const startPos = commandRange.start
                const text = document.getText(commandRange)
                const parseResult = parseCommandString(text, position.character - startPos.character, false)
                if (!parseResult) continue
                const { currentPartOffset, currentPartValue, allParts } = parseResult
                const curRange = new Range(
                    startPos.translate(0, currentPartOffset),
                    startPos.translate(0, fixEndingPos(text, currentPartOffset, currentPartValue)),
                )
                const includeInnerRange = ['"', "'"].includes(text[currentPartOffset])

                const commandStartPos = startPos.translate(0, allParts[0][1])
                const commandEndPos = startPos.translate(0, allParts.at(-1)![1] + allParts.at(-1)![0].length)
                const commandRangeSelection = { range: new Range(commandStartPos, commandEndPos) }

                const firstRange = includeInnerRange ? curRange.with(curRange.start.translate(0, 1), curRange.end.translate(0, -1)) : curRange
                const secondRange = includeInnerRange ? curRange : undefined
                // todo also include range option with value
                ranges.push({
                    range: firstRange,
                    parent: secondRange ? { range: secondRange, parent: commandRangeSelection } : commandRangeSelection,
                })
            }
            return ranges
        },
    })
    disposables.push(selectionProvider)

    registerSemanticHighlighting(documentSelector, options, disposables)

    // todo codeActions to shorten, unshorten options, subcommands (aliases)
}

const registerSemanticHighlighting = (
    documentSelector: DocumentSelector,
    { getAllSingleLineCommandLocations }: RegisterLanguageSupportOptions,
    disposables: Disposable[],
) => {
    if (!getAllSingleLineCommandLocations) return

    // temporarily use existing tokens, instead of defining own
    const tempTokensMap: Record<SemanticLegendType, string> = {
        command: 'namespace',
        subcommand: 'number',
        'option-arg': 'method',
        option: 'enumMember',
        arg: 'string',
        dangerous: 'keyword',
    }
    const semanticLegend = new SemanticTokensLegend(Object.values(tempTokensMap))

    const updateHighlightEvent = new EventEmitter<void>()
    const highlightProvider = languages.registerDocumentSemanticTokensProvider(
        documentSelector,
        {
            provideDocumentSemanticTokens(document, token) {
                if (!getExtensionSetting('semanticHighlighting', document)) return
                const builder = new SemanticTokensBuilder(semanticLegend)
                const inputRanges = getAllSingleLineCommandLocations(document)
                if (!inputRanges) return
                const ranges = getAllCommandLocations(document, inputRanges)
                for (const range of ranges) {
                    const collectedData: ParseCollectedData = {}
                    fullCommandParse(document, range, range.start, collectedData, 'semanticHighlight')
                    for (const part of collectedData.partsSemanticTypes ?? []) {
                        builder.push(part[0], tempTokensMap[part[1]])
                    }
                }

                const res = builder.build()
                return res
            },
            onDidChangeSemanticTokens: updateHighlightEvent.event,
        },
        semanticLegend,
    )
    // new spec is added, probably we can provide new highlights for option args etc
    specAddedEvent.event(() => updateHighlightEvent.fire())
    disposables.push(highlightProvider)

    disposables.push(
        workspace.onDidChangeConfiguration(({ affectsConfiguration }) => {
            if (affectsConfiguration('figUnreleased.semanticHighlighting') || affectsConfiguration('figUnreleased.ignoreClis')) {
                updateHighlightEvent.fire()
            }
        }),
    )
}

type DocumentEdit = {
    doc: TextDocument
    edits: Array<{
        command: string
        edit: TextEdit
    }>
}

const askForPathsUpdate = async (edits: DocumentEdit[]): Promise<boolean> => {
    if (getExtensionSetting('updatePathsOnFileRename') === 'always') return true
    const fileEdits = edits.map(({ doc, edits }) => `${workspace.asRelativePath(doc.uri)} (${edits.map(({ command }) => command).join(', ')})`).join('\n')
    const title = `Update paths for ${edits.length} files?`
    const choice = await window.showInformationMessage(
        title,
        {
            modal: true,
            detail: `Following files will be affected:\n${fileEdits}`,
        },
        { title: 'No', isCloseAffordance: true },
        { title: 'Yes' },
        { title: 'Always automatically update paths' },
        { title: 'Never ask again' },
    )
    if (!choice || choice.title === 'No') return false
    if (choice.title === 'Yes') return true

    const configuration = workspace.getConfiguration(CONTRIBUTION_PREFIX, null)
    if (choice.title === 'Always automatically update paths') {
        await configuration.update('updatePathsOnFileRename', 'always')
        return true
    }
    if (choice.title === 'Never ask again') {
        await configuration.update('updatePathsOnFileRename', 'never')
        return false
    }
    return false
}

const registerUpdateOnFileRename = () => {
    workspace.onDidRenameFiles(async ({ files: renamedFiles }) => {
        if (getExtensionSetting('updatePathsOnFileRename') === 'never') return
        const allContributedGlobs = compact(
            registeredLanguageProviders.map(({ pathAutoRename }) => (typeof pathAutoRename === 'object' ? pathAutoRename.glob : undefined)),
        )
        if (!allContributedGlobs.length) return
        const configuration = workspace.getConfiguration()
        // todo-low investigate using bulitin method
        const defaultSearchExcludeGlob = Object.entries({ ...(configuration.get('files.exclude') as {}), ...(configuration.get('search.exclude') as {}) })
            .filter(([key, val]: [string, boolean]) => val === true && !key.includes('{'))
            .map(([key]) => key)
        // todo provide loading ui + cancel, if > 300ms
        const tokenSource = new CancellationTokenSource()
        setTimeout(() => tokenSource.cancel(), 300)
        const foundUris = await workspace.findFiles(
            `**/{${allContributedGlobs.join(',')}}`,
            `**/{${defaultSearchExcludeGlob.join(',')}}`,
            80,
            tokenSource.token,
        )
        const documentsToParse = await urisToDocuments(foundUris)

        const edits: DocumentEdit[] = []
        for (const document of documentsToParse) {
            const { getAllSingleLineCommandLocations } = getBestLanguageProvider(document) ?? {}
            if (!getAllSingleLineCommandLocations) continue
            const inputRanges = getAllSingleLineCommandLocations(document)
            if (!inputRanges) continue
            const ranges = getAllCommandLocations(document, inputRanges)
            if (!ranges) continue
            const docEdits: DocumentEdit = {
                doc: document,
                edits: [],
            }

            for (const range of ranges) {
                const collectedData: ParseCollectedData = {}
                fullCommandParse(document, range, range.start, collectedData, 'pathParts')
                for (const part of collectedData.filePathParts ?? []) {
                    const docCwd = getCwdUri(document)!
                    const renamedFile = renamedFiles.find(({ oldUri }) => oldUri.toString() === Uri.joinPath(docCwd, part[0]).toString())
                    if (!renamedFile) continue
                    const newPath = renamedFile.newUri.path
                    const newRelativePath = relative(docCwd.path, newPath)
                    // todo1 preserve ./
                    docEdits.edits.push({
                        command: collectedData.specName!,
                        edit: { range: part[3], newText: newRelativePath },
                    })
                }
            }
            if (docEdits.edits.length > 0) edits.push(docEdits)
        }
        if (edits.length && (await askForPathsUpdate(edits))) {
            const workspaceEdit = new WorkspaceEdit()
            for (const { doc, edits: docEdits } of edits) {
                workspaceEdit.set(
                    doc.uri,
                    docEdits.map(({ edit }) => edit),
                )
            }
            await workspace.applyEdit(workspaceEdit)
        }
    })
}

const tabsToDocuments = (tabs: readonly Tab[]) => urisToDocuments(compact(tabs.map(tab => (tab.input instanceof TabInputText ? tab.input.uri : undefined))))

// All linting & parsing logic was writting with the following in mind:
// Each command range can take one line only
const registerLinter = () => {
    const diagnosticCollection = languages.createDiagnosticCollection(CONTRIBUTION_PREFIX)
    /** currently included documents into linting, all visible tabs for now */
    let supportedDocuments: TextDocument[] = []
    const doLinting = (document: TextDocument) => {
        if (!getExtensionSetting('validate')) {
            diagnosticCollection.set(document.uri, [])
            return
        }
        const { getAllSingleLineCommandLocations } = getBestLanguageProvider(document) ?? {}
        if (!getAllSingleLineCommandLocations) return
        const inputRanges = getAllSingleLineCommandLocations(document)
        if (!inputRanges) return

        const lintTypeToSettingMap: Record<LintProblemType, string> = {
            commandName: 'commandName',
            noArgInput: 'noArgInput',
            option: 'optionName',
            commandNotAllowedContext: 'commandNotAllowedContext',
        }
        const lintConfiguration: Record<string, 'ignore' | '' /*don't care of severities*/> =
            workspace.getConfiguration(CONTRIBUTION_PREFIX, document).get('lint') ?? {}

        const allLintProblems: ParseCollectedData['lintProblems'] = []
        const lintRanges = getAllCommandLocations(document, inputRanges)
        for (const range of lintRanges) {
            if (range.start.isEqual(range.end)) continue
            const collectedData: ParseCollectedData = {}
            fullCommandParse(document, range, range.start, collectedData, 'lint', {
                includeSpecContextLint: lintConfiguration.commandNotAllowedContext !== 'ignore',
            })
            const { lintProblems = [] } = collectedData
            allLintProblems.push(...lintProblems)
        }
        diagnosticCollection.set(
            document.uri,
            compact(
                allLintProblems.map(({ message, range, type, code }) => {
                    const controlledSettingName = lintTypeToSettingMap[type]
                    const controlledSettingValue = controlledSettingName && lintConfiguration[controlledSettingName]
                    if (controlledSettingValue === 'ignore') return
                    const severitySettingMap = {
                        information: DiagnosticSeverity.Information,
                        warning: DiagnosticSeverity.Warning,
                        error: DiagnosticSeverity.Error,
                    }
                    const severity = severitySettingMap[controlledSettingValue ?? ''] ?? severitySettingMap.information
                    return {
                        message,
                        range: new Range(...range),
                        severity,
                        source: 'fig',
                        code: code ?? type,
                    }
                }),
            ),
        )
    }
    const lintDocuments = (documents: TextDocument[]) => {
        for (const document of documents) {
            doLinting(document)
        }
    }
    const lintAllDocuments = async () => {
        const allTabs = window.tabGroups.all.flatMap(({ tabs }) => tabs)
        supportedDocuments = await tabsToDocuments(allTabs)
        lintDocuments(supportedDocuments)
    }
    lintAllDocuments()

    window.tabGroups.onDidChangeTabs(async ({ opened }) => {
        const newDocuments = (await tabsToDocuments(opened)).filter(document => !supportedDocuments.includes(document))
        supportedDocuments.push(...newDocuments)
        lintDocuments(newDocuments)
    })
    workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
        if (!supportedDocuments.includes(document)) return
        if (globalSettings.autoParameterHints === 'afterSpace' && contentChanges.length && contentChanges.every(({ text }) => text === ' ')) {
            commands.executeCommand('editor.action.triggerParameterHints')
        }
        doLinting(document)
    })
    workspace.onDidChangeConfiguration(({ affectsConfiguration }) => {
        if (['figUnreleased.validate', 'figUnreleased.lint', 'figUnreleased.ignoreClis'].some(key => affectsConfiguration(key))) lintAllDocuments()
    })
    relintEvent.event((documents = supportedDocuments) => {
        lintDocuments(documents)
    })
    languageSupportRegisteredEvent.event(() => {
        lintAllDocuments()
    })
}

// Unimplemented commands

// extremely useful for giving a link to a friend, like hey I was right about the options!
const openInSheelHow = (skipOpening = false) => {
    const { activeTextEditor } = window
    if (!activeTextEditor) return
    const { document, selection } = activeTextEditor
    // let scriptToOpen = selection.start.isEqual(selection.end) ? getCurrentCommand() : document.getText(selection)
}
