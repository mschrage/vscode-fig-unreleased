/// <reference types="@withfig/autocomplete-types/index" />
import _FIG_ALL_SPECS from 'FIG_ALL_SPECS'
import picomatch from 'picomatch/posix'
import {
    commands,
    CompletionItem,
    CompletionItemKind,
    CompletionItemLabel,
    CompletionItemTag,
    DiagnosticSeverity,
    DocumentSelector,
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
    TextDocument,
    TextEdit,
    Uri,
    window,
    workspace,
    WorkspaceEdit,
} from 'vscode'
import { API } from './extension-api'
import { niceLookingCompletion } from '@zardoy/vscode-utils/build/completions'
import { compact, ensureArray, findCustomArray, oneOf } from '@zardoy/utils'
import { parse } from './shell-quote-patched'
import _ from 'lodash'
import { findNodeAtLocation, getLocation, Node, parseTree } from 'jsonc-parser'
import { getJsonCompletingInfo } from '@zardoy/vscode-utils/build/jsonCompletions'
import { relative } from 'path-browserify'

const getFigSubcommand = (__spec: Fig.Spec) => {
    const _spec = typeof __spec === 'function' ? __spec() : __spec
    const spec = 'versionedSpecPath' in _spec ? undefined! : _spec
    return spec
}

const ALL_LOADED_SPECS = _FIG_ALL_SPECS.map(mod => mod.default).map(value => getFigSubcommand(value)!)

let isScriptExecutionAllowed = false

export const activate = ({}: ExtensionContext) => {
    isScriptExecutionAllowed = workspace.isTrusted
    workspace.onDidGrantWorkspaceTrust(() => {
        isScriptExecutionAllowed = true
    })

    registerCommands()
    registerLanguageProviders()
    registerUpdateOnFileRename()
    registerLinter()
    // todo impl setting

    const api: API = {
        /** let other extensions contribute/extend with their completions */
        addCompletions(rootSubcommand) {
            ALL_LOADED_SPECS.push(rootSubcommand)
        },
        getCompletionsSpecs() {
            return ALL_LOADED_SPECS
        },
    }
    return api
}

// Will be implemented into vscode settings
const globalSettings = {
    insertOnCompletionAccept: 'space' as 'space' | 'disabled',
    // clickPathAction: 'revealInExplorer' | 'openInEditor'
}

// #region Constants
const SUPPORTED_SHELL_SELECTOR: DocumentSelector = ['bat', 'shellscript']
const SUPPORTED_PACKAGE_JSON_SELECTOR: DocumentSelector = { pattern: '**/package.json' }
const SUPPORTED_ALL_SELECTOR: DocumentSelector = [...SUPPORTED_SHELL_SELECTOR, SUPPORTED_PACKAGE_JSON_SELECTOR]

/** this commands (specs) come from npm packages
 * they should be probably installed locally */
const FIG_PACKAGES_COMMANDS = ['eslint', 'electron', 'dotenv', 'esbuild', 'webpack', 'jest', 'vite', 'pre-commit', 'rollup', 'vue', 'ts-node', 'tsc']
// probably vsce, vercel, volta, turbo, serve
// todo other for package.json: suggest only installed clis, try to ban macos-only
// #endregion

// Temporary maps
// todo remove temp for all, introduce placeholders
const niceIconMap = {
    // experimentally set all options of the spec to icon file
    esbuild: 'esbuild.js',
}

const stableIconMap = {
    'fig://icon?type=yarn': 'yarn.lock',
    'fig://icon?type=npm': 'package.json',
    'ffig://icon?type=git': '.gitkeep',
}

// I included regions, so you can easily collapse categories.

// #region types
type CommandPartTuple = [contents: string, offset: number, isOption: boolean]
type CommandParts = Array<[content: string, offset: number]>

// todo resolve sorting!
interface DocumentInfo extends ParseCommandStringResult {
    // used for providing correct editing range
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
    kind?: CompletionItemKind
    sortTextPrepend?: string
    specName?: string
    rangeShouldReplace?: boolean
}

type UsedOption = string

// #endregion// #region Suggestions getters
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
        currentPartOffset,
    }: DocumentInfoForCompl & { sortTextPrepend: string },
): CompletionItem | undefined => {
    const {
        displayName,
        insertValue,
        description,
        icon,
        /* isDangerous, */
        priority = 50,
        hidden,
        deprecated,
    } = baseCompetion
    const STRING_TRUNCATE_LENGTH = 10
    let descriptionText = undefined
    // let descriptionText = (description && markdownToTxt(description)) || undefined
    // if (descriptionText && descriptionText.length > STRING_TRUNCATE_LENGTH) descriptionText = `${descriptionText!.slice(0, STRING_TRUNCATE_LENGTH)}`

    if (hidden && currentPartValue !== initialName) return undefined
    const completion = new CompletionItem({ label: displayName || initialName, description: descriptionText })

    completion.insertText = insertValue !== undefined ? new SnippetString().appendText(insertValue) : undefined
    if (completion.insertText) completion.insertText.value = completion.insertText.value.replace(/{cursor\\}/, '$1')
    completion.documentation = (description && new MarkdownString(description)) || undefined
    // lets be sure its consistent
    completion.sortText = sortTextPrepend + priority.toString().padStart(3, '0')
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

    if (specName && kind === undefined) {
        const niceLookingIcon = niceIconMap[specName]
        if (niceLookingIcon) Object.assign(completion, niceLookingCompletion(niceLookingIcon))
    }
    if (icon) {
        const mappedIcon = stableIconMap[icon]
        if (mappedIcon) Object.assign(completion, niceLookingCompletion(mappedIcon))
    }

    return completion
}

const getRootSpecCompletions = (info: Omit<DocumentInfoForCompl, 'sortTextPrepend'>, includeOnlyList?: string[]) => {
    return compact(
        ALL_LOADED_SPECS.map(specCommand => {
            let { name } = specCommand
            // todo display both?
            if (Array.isArray(name)) name = name[0]
            if (includeOnlyList && !includeOnlyList.includes(name)) return
            const completion = figBaseSuggestionToVscodeCompletion(specCommand, name, { ...info, sortTextPrepend: '' })
            if (!completion) return
            Object.assign(completion, niceLookingCompletion('.sh'))
            return completion
        }),
    )
}

// todo to options, introduce flattened lvl
const listFilesCompletions = async (cwd: Uri, stringContents: string, completionPos: Position | undefined, globFilter?: string, includeType?: FileType) => {
    const folderPath = stringContents.split('/').slice(0, -1).join('/')
    const pathLastPart = stringContents.split('/').pop()!
    let filesList: [name: string, type: FileType][]
    try {
        filesList = await workspace.fs.readDirectory(Uri.joinPath(cwd, folderPath))
    } catch {
        filesList = []
    }
    const isMatch = globFilter && picomatch(globFilter)
    // todo insertText
    return filesList
        .map(([name, type]): CompletionItem => {
            if ((includeType && !(type & includeType)) || (isMatch && !isMatch(name))) return undefined!
            const isDir = type & FileType.Directory
            return {
                label: isDir ? `${name}/` : name,
                kind: !isDir ? CompletionItemKind.File : CompletionItemKind.Folder,
                detail: name,
                // sort bind
                sortText: `a${isDir ? 1 : 2}`,
                command: isDir
                    ? {
                          command: 'editor.action.triggerSuggest',
                          title: '',
                      }
                    : undefined,
                // todo-low
                range: completionPos && new Range(completionPos.translate(0, -pathLastPart.replace(/^ /, '').length), completionPos),
            }
        })
        .filter(Boolean)
}

const templateToVscodeCompletion = async (_template: Fig.Template, info: DocumentInfo) => {
    const templates = ensureArray(_template)
    const completions: CompletionItem[] = []
    let includeFilesKindType: FileType | true | undefined
    if (templates.includes('folders')) includeFilesKindType = FileType.Directory
    if (templates.includes('filepaths')) includeFilesKindType = true
    // todo
    const includeHelp = templates.includes('help')
    if (includeFilesKindType) {
        const cwd = getCwdUri(info._document)
        if (cwd)
            completions.push(
                ...(await listFilesCompletions(
                    cwd,
                    info.currentPartValue ?? '',
                    info.realPos,
                    // undefined,
                    // includeFilesKindType === true ? undefined : includeFilesKindType,
                )),
            )
    }
    return completions
}

const figSubcommandsToVscodeCompletions = (subcommands: Fig.Subcommand[], info: DocumentInfo): CompletionItem[] | undefined => {
    const { currentPartValue = '' } = info
    return compact(
        subcommands.map(subcommand => {
            const nameArr = ensureArray(subcommand.name)
            const completion = figBaseSuggestionToVscodeCompletion(
                subcommand,
                nameArr.find(name => name.toLowerCase().includes(currentPartValue.toLowerCase())) ?? nameArr[0],
                {
                    ...info,
                    kind: CompletionItemKind.Module,
                    sortTextPrepend: 'c',
                },
            )
            if (!completion) return
            let insertSpace = subcommand.requiresSubcommand /*  && globalSettings.insertOnCompletionAccept === 'space' */
            if (!insertSpace) {
                // todo is that right?
                if (subcommand.subcommands) insertSpace = true
                for (const arg of ensureArray(subcommand.args ?? [])) {
                    if (arg.isOptional) continue
                    insertSpace = true
                    break
                }
            }
            if (completion.insertText === undefined && insertSpace) completion.insertText = (completion.label as CompletionItemLabel).label + ' '
            return completion
        }),
    )
}

const figSuggestionToCompletion = (suggestion: string | Fig.Suggestion, documentInfo: DocumentInfoForCompl) => {
    if (typeof suggestion === 'string')
        suggestion = {
            name: suggestion,
        }
    const completion = figBaseSuggestionToVscodeCompletion(suggestion, ensureArray(suggestion.name)[0]!, {
        kind: CompletionItemKind.Constant,
        sortTextPrepend: 'a',
        ...documentInfo,
    })
    return completion
}

const figArgToCompletions = async (arg: Fig.Arg, documentInfo: DocumentInfo) => {
    const completions: CompletionItem[] = []
    // todo optionsCanBreakVariadicArg suggestCurrentToken
    const { suggestions, template, default: defaultValue, generators } = arg
    // todo expect all props, handle type
    if (suggestions) completions.push(...compact(suggestions.map(suggestion => figSuggestionToCompletion(suggestion, documentInfo))))
    if (template) completions.push(...(await templateToVscodeCompletion(template, documentInfo)))
    if (generators) {
        for (const { template, filterTemplateSuggestions } of ensureArray(generators)) {
            // todo
            if (!template) continue
            let suggestions = await templateToVscodeCompletion(template, documentInfo)
            if (filterTemplateSuggestions)
                suggestions = filterTemplateSuggestions(
                    suggestions.map(suggestion => ({
                        ...suggestion,
                        name: suggestion.label as string,
                        context: { templateType: 'filepaths' },
                    })),
                ) as any
            completions.push(...suggestions)
        }
    }
    if (defaultValue) {
        for (const completion of completions) {
            if (typeof completion.label !== 'object') continue
            // todo comp name?
            if (completion.label.label === defaultValue) completion.label.description = 'DEFAULT'
        }
    }
    return completions
}

// imo specOptions is more memorizable rather than commandOptions
const specOptionsToVscodeCompletions = (subcommand: Fig.Subcommand, documentInfo: DocumentInfo) => {
    return compact(getNormalizedSpecOptions(subcommand)?.map(option => parseOptionToCompletion(option, documentInfo)) ?? [])
}

// todo need think: it seems that fig does start-only filtering by default
// todo hide commands
const parseOptionToCompletion = (option: Fig.Option, info: DocumentInfo): CompletionItem | undefined => {
    let { isRequired, isRepeatable = false, requiresSeparator: seperator = false, dependsOn, exclusiveOn } = option

    if (seperator === true) seperator = '='
    if (seperator === false) seperator = ''

    const usedOptionsNames = info.usedOptions
    const currentOptionsArr = ensureArray(option.name)

    const optionUsedCount = usedOptionsNames.filter(name => currentOptionsArr.includes(name)).length
    if (isRepeatable === false && optionUsedCount > 0) return
    if (typeof isRepeatable === 'number' && optionUsedCount >= isRepeatable) return

    if (dependsOn && !dependsOn.every(name => usedOptionsNames.includes(name))) return
    if (exclusiveOn?.some(name => usedOptionsNames.includes(name))) return

    const optionsRender = currentOptionsArr.join(' ')
    const completion = figBaseSuggestionToVscodeCompletion(option, optionsRender, { ...info, sortTextPrepend: 'd' })
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
    const defaultInsertSpace =
        globalSettings.insertOnCompletionAccept === 'space' && info.inputString[info.currentPartOffset + info.currentPartValue.length] !== ' '
    const defaultInsertText = insertOption + seperator + (seperator.length !== 1 && defaultInsertSpace ? ' ' : '')
    completion.insertText ??= defaultInsertText
    completion.command = {
        command: APPLY_SUGGESTION_COMPLETION_COMMAND,
        title: '',
    }

    return completion
}

// #endregion

// #region Completion helpers
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
const getExtensionSetting = <T = any>(key: string) => workspace.getConfiguration('figUnreleased').get<T>(key)

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
const fixEndingPos = (inputString: string, endingOffset: number) => {
    const char = inputString[endingOffset + 1]
    return ["'", '"'].includes(char) ? endingOffset + 2 : endingOffset
}
const fixPathArgRange = (inputString: string, startOffset: number, rangePos: [Position, Position]): [Position, Position] => {
    const char = inputString[startOffset]
    return ["'", '"'].includes(char) ? [rangePos[0].translate(0, 1), rangePos[1].translate(0, -1)] : rangePos
}

const isSupportedDocument = (document: TextDocument) => {
    return languages.match(SUPPORTED_ALL_SELECTOR, document)
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
    const commandsParts = (parse(inputString) as any[]).reduce<CommandParts[]>(
        (prev, parsedPart) => {
            if (Array.isArray(parsedPart)) {
                const last = prev.slice(-1)[0]!
                // remove placeholder
                if (last.length === 1 && last[0][0] === '') last.splice(0, 1)
                last.push(parsedPart as any)
            } else {
                // add empty placeholder so we know op position
                prev.push([['', parsedPart.index]])
            }
            return prev
        },
        [[]],
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

// todo parserDirectives
export const parseCommandString = (inputString: string, stringPos: number, stripCurrentValue: boolean): ParseCommandStringResult | undefined => {
    let currentPartIndex = 0
    let currentPartOffset = 0
    let currentPartValue = ''
    let currentCommandParts: CommandParts | undefined
    // todo reverse them
    const allCommandsFromString = getAllCommandsFromString(inputString).map(parts => (parts.length ? parts : ([['', inputString.length]] as CommandParts)))
    for (const commandParts of allCommandsFromString) {
        const firstCommandPart = commandParts[0]
        if (firstCommandPart?.[1] <= stringPos) {
            currentCommandParts = commandParts
        } else {
            break
        }
    }
    // needs currentCommandPartEnd
    // pushing even if in mid pos
    if (currentCommandParts[0][0] !== '' && inputString[stringPos - 1] === ' ')
        currentCommandParts.push([' ', currentCommandParts.at(-1)[1] + currentCommandParts.at(-1)[0].length])
    for (const [i, currentCommandPart] of currentCommandParts.entries()) {
        if (currentCommandPart?.[1] <= stringPos) {
            currentPartIndex = i
            currentPartOffset = currentCommandPart[1]
            currentPartValue = stripCurrentValue ? currentCommandPart[0].slice(0, stringPos - currentCommandPart?.[1]) : currentCommandPart[0]
        } else {
            break
        }
    }
    return {
        allParts: currentCommandParts.map(([c, offset]) => [c, offset, commandPartIsOption(c)] as CommandPartTuple),
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
    options: { stripCurrentValue: boolean },
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
        inputString: stringContents.slice(allParts[0][1], allParts.at(-1)![1] + allParts.at(-1)![0].length),
        specName: allParts[0][0],
        currentPartValue,
        usedOptions: allParts.filter(([content], index) => commandPartIsOption(content) && index !== currentPartIndex).map(([content]) => content),
        currentPartOffset,
        currentPartIndex,
        allParts,
        currentPartIsOption,
        parsedInfo: {
            completingOptionValue: previousPartIsOptionWithArg
                ? {
                      paramName: preCurrentValue,
                      currentEnteredValue: currentPartValue!,
                  }
                : undefined,
            // holds option + value, used for things like hover
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
    // todo escape markdown
    let text = type && `(${type}) `
    return {
        contents: [new MarkdownString().appendText(text).appendMarkdown(description)],
        range: range && new Range(range[0], range[1]),
    }
}

type LintProblemType = 'commandName' | 'option' | 'arg'
type LintProblem = {
    // for severity
    type: LintProblemType
    range: [Position, Position]
    message: string
}

// can also be refactored to try/finally instead, but'd require extra indent
interface ParseCollectedData {
    argSignatureHelp?: Fig.Arg
    hoverRange?: [Position, Position]
    currentOption?: Fig.Option
    currentSubcommand?: Fig.Option

    currentPart?: CommandPartTuple
    currentPartIndex?: number
    currentPartRange?: [Position, Position]

    collectedCompletions?: CompletionItem[]
    collectedCompletionsPromise?: Promise<CompletionItem[]>[]
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
    parsingReason: 'completions' | 'signatureHelp' | 'hover' | 'lint' | 'path-parts' | 'semanticHighlight',
): undefined => {
    // todo
    const knownSpecNames = ALL_LOADED_SPECS.flatMap(({ name }) => ensureArray(name))
    const inputText = document.getText(inputRange)
    const startPos = inputRange.start
    const stringPos = _position.character - startPos.character
    const documentInfo = getDocumentParsedResult(document, inputText, _position, stringPos, startPos, {
        stripCurrentValue: parsingReason === 'completions',
    })
    if (!documentInfo) return
    let { allParts, currentPartValue, currentPartIndex, currentPartIsOption } = documentInfo
    const inspectOnlyAllParts = oneOf(parsingReason, 'lint', 'semanticHighlight', 'path-parts') as boolean

    // avoid using positions to avoid .translate() crashes
    if (parsingReason !== 'completions') {
        documentInfo.realPos = undefined
        documentInfo.startPos = undefined
    }
    const partToRange = (index: number) => {
        const [contents, offset] = allParts[index]
        return [startPos.translate(0, offset), startPos.translate(0, fixEndingPos(inputText, offset + contents.length))] as [Position, Position]
    }
    collectedData.partsSemanticTypes = []
    collectedData.currentPartIndex = currentPartIndex
    collectedData.hoverRange = partToRange(currentPartIndex)
    collectedData.lintProblems = []
    collectedData.collectedCompletions = []
    collectedData.collectedCompletionsPromise = []
    collectedData.filePathParts = []

    const setSemanticType = (index: number, type: SemanticLegendType) => {
        collectedData.partsSemanticTypes!.push([new Range(...partToRange(index)), type])
    }
    setSemanticType(0, 'command')
    // is in command name
    if (currentPartIndex === 0) {
        collectedData.collectedCompletions = getRootSpecCompletions(documentInfo)
        if (parsingReason === 'hover') {
            const spec = getCompletingSpec(documentInfo.specName)
            collectedData.currentSubcommand = spec && getFigSubcommand(spec)
        }
        if (!inspectOnlyAllParts) return
    }
    // validate command name
    if (parsingReason === 'lint' && documentInfo.specName !== '' && !knownSpecNames.includes(documentInfo.specName)) {
        collectedData.lintProblems.push({
            message: `Unknown command ${documentInfo.specName}`,
            range: partToRange(0),
            type: 'commandName',
        })
    }
    const spec = getCompletingSpec(documentInfo.specName)
    if (!spec) return
    const figRootSubcommand = getFigSubcommand(spec)

    const getIsPathPart = (arg: Fig.Arg) => {
        const isPathTemplate = ({ template }: { template?: Fig.Template }): boolean =>
            !!template && ensureArray(template).filter(item => item === 'filepaths' || item === 'folders').length > 0
        return isPathTemplate(arg) || ensureArray(arg.generators ?? []).some(gen => isPathTemplate(gen))
    }
    const changeCollectedDataPath = (arg: Fig.Arg, i: number) => {
        const part = allParts[i]
        // todo duplication
        collectedData.currentFilePathPart = getIsPathPart(arg) ? [...part, new Range(...fixPathArgRange(inputText, part[1], partToRange(i)))] : undefined
    }
    const addPossiblyPathPart = (i: number, args: Fig.Arg[] | Fig.Arg) => {
        const isPathPart = ensureArray(args).some(arg => getIsPathPart(arg))
        if (!isPathPart) return
        const part = allParts[i]
        collectedData.filePathParts.push([...part, new Range(...fixPathArgRange(inputText, part[1], partToRange(i)))])
    }

    const { completingOptionValue: completingParamValue, completingOptionFull } = documentInfo.parsedInfo
    const goingToSuggest = {
        options: true,
        subcommands: true,
    }
    let subcommand = figRootSubcommand
    const getSubcommandOption = (name: string) =>
        subcommand.options?.find(({ name: optName }) => (Array.isArray(optName) ? optName.includes(name) : optName === name))
    // todo r
    let argMetCount = 0
    // todo resolv
    const alreadyUsedOptions = [] as string[]
    collectedData.currentPart = allParts[currentPartIndex]
    collectedData.currentPartRange = partToRange(currentPartIndex)
    for (const [_iteratingPartIndex, [partContents, _partStartPos, partIsOption]] of (!inspectOnlyAllParts
        ? allParts.slice(1, currentPartIndex)
        : allParts.slice(1)
    ).entries()) {
        const partIndex = _iteratingPartIndex + 1
        if (partIsOption) {
            // todo is that right?
            if (partContents === '--') {
                goingToSuggest.options = false
                goingToSuggest.subcommands = false
            }
            let message: string | undefined
            // don't be too annoying for -- and -
            if (!inspectOnlyAllParts || /^--?$/.exec(partContents)) continue
            // todo arg
            if (getSubcommandOption(partContents)?.isDangerous) setSemanticType(partIndex, 'dangerous')
            else setSemanticType(partIndex, 'option')
            if (subcommand.parserDirectives?.optionArgSeparators) continue
            // below: lint option
            if (!subcommand.options || subcommand.options.length === 0) message = "Command doesn't take options here"
            else {
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
                    message = `Unknown option ${partContents}`
                    if (guessedOptionName) message += ` Did you mean ${guessedOptionName}?`
                } else if (alreadyUsedOptions.includes(partContents)) {
                    message = `${partContents} option was already used [here]`
                }
            }
            if (message) {
                collectedData.lintProblems.push({
                    message,
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
                addPossiblyPathPart(partIndex, getSubcommandOption(allParts[partIndex - 1][0]).args)
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
                    type: 'arg',
                })
            }
        }
    }
    // todo make it easier to see & understand
    if (inspectOnlyAllParts) return
    const pushCompletions = (items: CompletionItem[] | undefined) => collectedData.collectedCompletions.push(...(items ?? []))
    const pushPromiseCompletions = (items: Promise<CompletionItem[]> | undefined) => collectedData.collectedCompletionsPromise.push(...([items] ?? []))
    if (/* !currentPartIsOption */ true) {
        const { subcommands, additionalSuggestions } = subcommand
        for (const arg of ensureArray(subcommand.args ?? [])) {
            if (!arg.isVariadic && argMetCount !== 0) continue
            pushPromiseCompletions(figArgToCompletions(arg, documentInfo))
            changeCollectedDataPath(arg, currentPartIndex)
            if (!currentPartIsOption) collectedData.argSignatureHelp = arg
            // todo is that right? (stopping at first one)
            break
        }
        if (parsingReason === 'hover' && !currentPartIsOption && subcommands) {
            collectedData.currentSubcommand = subcommands.find(({ name }) => ensureArray(name).includes(currentPartValue))
        }
        if (goingToSuggest.subcommands) {
            pushCompletions(subcommands && figSubcommandsToVscodeCompletions(subcommands, documentInfo))
            if (additionalSuggestions)
                pushCompletions(
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
            if (Array.isArray(args)) args = args[0]
            if (args) {
                collectedData.argSignatureHelp = args
                changeCollectedDataPath(args, currentPartIndex)
                if (!args.isOptional) {
                    // make sure only arg completions are showed
                    // todo r
                    collectedData.collectedCompletions.splice(0, collectedData.collectedCompletions.length)
                    goingToSuggest.options = false
                }
                pushPromiseCompletions(figArgToCompletions(args, patchedDocumentInfo))
            }
        }

        if (goingToSuggest.options) pushCompletions(specOptionsToVscodeCompletions(subcommand, patchedDocumentInfo))
    }

    collectedData.collectedCompletionsIncomplete = true
}

type DocumentWithPos<R> = (document: TextDocument, position: Position) => R

// #region Range providers
// they handle requesting position in file
const provideRangeFromDocumentPositionPackageJson: DocumentWithPos<Range> = (document, position) => {
    const offset = document.offsetAt(position)
    const location = getLocation(document.getText(), offset)
    if (!location?.matches(['scripts', '*'])) return
    const jsonCompletingInfo = getJsonCompletingInfo(location, document, position)
    const { insideStringRange } = jsonCompletingInfo || {}
    if (!insideStringRange) return
    return insideStringRange
}

const shellBannedLineRegex = /^\s*(#|::|if|else|fi|return|function|"|'|[\w\d]+(=|\())/i
const provideRangeFromDocumentPositionShellFile: DocumentWithPos<Range> = (document, position) => {
    const line = document.lineAt(position)
    shellBannedLineRegex.lastIndex = 0
    if (shellBannedLineRegex.test(line.text)) return
    return line.range
}

const provideRangeFromDocumentPosition: DocumentWithPos<Range | undefined> = (document, position) => {
    // todo fix \"
    if (languages.match(SUPPORTED_PACKAGE_JSON_SELECTOR, document)) return provideRangeFromDocumentPositionPackageJson(document, position)
    if (languages.match(SUPPORTED_SHELL_SELECTOR, document)) return provideRangeFromDocumentPositionShellFile(document, position)
}
// #endregion

// #region All commands location
// they return all command location for requesting file
const getInputCommandsShellFile = (document: TextDocument) => {
    const ranges: Range[] = []
    for (let lineNum = 0; lineNum < document.lineCount; lineNum++) {
        const { text, range } = document.lineAt(lineNum)
        shellBannedLineRegex.lastIndex = 0
        if (shellBannedLineRegex.test(text)) continue
        ranges.push(range)
    }
    return ranges
}

const getInputCommandsPackageJson = (document: TextDocument) => {
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
}

const getAllCommandsLocations = (document: TextDocument) => {
    const outputRanges: Range[] = []
    const inputRanges = languages.match(SUPPORTED_PACKAGE_JSON_SELECTOR, document) ? getInputCommandsPackageJson(document) : getInputCommandsShellFile(document)
    for (const range of inputRanges ?? []) {
        const allCommands = getAllCommandsFromString(document.getText(range))
        outputRanges.push(
            ...compact(
                allCommands.map(parts => {
                    const firstPart = parts[0]
                    if (!firstPart) return
                    const [, startOffset] = firstPart
                    const [lastContents, endOffset] = parts.at(-1)
                    const startPos = range.start
                    return new Range(startPos.translate(0, startOffset), startPos.translate(0, endOffset + lastContents.length))
                }),
            ),
        )
    }
    return outputRanges
}
// #endregion

// lifted for type inferrence
const semanticLegendTypes = ['command', 'subcommand', 'arg', 'option', 'option-arg', 'dangerous'] as const
type SemanticLegendType = typeof semanticLegendTypes[number]

const APPLY_SUGGESTION_COMPLETION_COMMAND = '_applyFigSuggestion'

const registerCommands = () => {
    commands.registerCommand(APPLY_SUGGESTION_COMPLETION_COMMAND, () => {
        commands.executeCommand('editor.action.triggerSuggest')
        commands.executeCommand('editor.action.triggerParameterHints')
    })
}

const registerLanguageProviders = () => {
    languages.registerCompletionItemProvider(
        SUPPORTED_ALL_SELECTOR,
        {
            async provideCompletionItems(document, position, token, context) {
                const commandRange = provideRangeFromDocumentPosition(document, position)
                if (!commandRange) return
                const collectedData: ParseCollectedData = {}
                fullCommandParse(document, commandRange, position, collectedData, 'completions')
                const { collectedCompletions = [], collectedCompletionsPromise = [], collectedCompletionsIncomplete } = collectedData
                const completionsFromPromise = await Promise.all(collectedCompletionsPromise)
                return { items: [...collectedCompletions, ...completionsFromPromise.flat(1)] ?? [], isIncomplete: collectedCompletionsIncomplete }
            },
        },
        ' ',
        '-',
        // file path
        '/',
        // file ext
        '.',
    )

    languages.registerSignatureHelpProvider(SUPPORTED_ALL_SELECTOR, {
        provideSignatureHelp(document, position, token, context) {
            const commandRange = provideRangeFromDocumentPosition(document, position)
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
    })
    languages.registerHoverProvider(SUPPORTED_ALL_SELECTOR, {
        provideHover(document, position) {
            const commandRange = provideRangeFromDocumentPosition(document, position)
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

    const pathStringToUri = (document: TextDocument, contents: string) => {
        const cwdUri = getCwdUri(document)
        if (!cwdUri) return
        return Uri.joinPath(cwdUri, contents)
    }

    const getFilePathPart: DocumentWithPos<{ range: Range; contents: string; uri?: Thenable<Uri | undefined> } | undefined> = (document, position) => {
        const commandRange = provideRangeFromDocumentPosition(document, position)
        if (!commandRange) return
        const collectedData: ParseCollectedData = {}
        fullCommandParse(document, commandRange, position, collectedData, 'signatureHelp')
        let { currentFilePathPart } = collectedData
        if (!currentFilePathPart) return
        const uri = pathStringToUri(document, currentFilePathPart[0])
        return {
            range: currentFilePathPart[3],
            contents: currentFilePathPart[0],
            // uri of existing file
            uri: workspace.fs.stat(uri).then(
                () => uri,
                () => undefined,
            ),
        }
    }

    languages.registerDefinitionProvider(SUPPORTED_ALL_SELECTOR, {
        provideDefinition(document, position, token) {
            const { contents, uri, range } = getFilePathPart(document, position) ?? {}
            if (!contents) return
            // also its possible to migrate to link provider that support command: protocol
            return [
                {
                    targetRange: new Range(new Position(0, 0), new Position(0, 100)),
                    targetUri: uri,
                    // todo use inner
                    originSelectionRange: range,
                } as LocationLink,
            ]
        },
    })

    languages.registerRenameProvider(SUPPORTED_ALL_SELECTOR, {
        async prepareRename(document, position, token) {
            const { range, uri } = getFilePathPart(document, position) ?? {}
            if (!range) throw new Error('You cannot rename this element')
            if (!(await uri)) throw new Error("Renaming file doesn't exist")
            return range
        },
        async provideRenameEdits(document, position, newName, token) {
            const { range, uri } = getFilePathPart(document, position) ?? {}
            if (!uri) return
            const edit = new WorkspaceEdit()
            edit.set(document.uri, [{ range, newText: newName }])
            edit.renameFile(await uri, Uri.joinPath(getCwdUri({ uri: await uri })!, newName))
            return edit
        },
    })

    // temporarily use existing tokens, instead of defining own in demo purposes
    const tempTokensMap: Record<SemanticLegendType, string> = {
        command: 'namespace',
        subcommand: 'number',
        'option-arg': 'method',
        option: 'enumMember',
        // option:
        arg: 'string',
        dangerous: 'keyword',
    }
    const semanticLegend = new SemanticTokensLegend(Object.values(tempTokensMap))

    languages.registerDocumentSemanticTokensProvider(
        SUPPORTED_ALL_SELECTOR,
        {
            provideDocumentSemanticTokens(document, token) {
                const builder = new SemanticTokensBuilder(semanticLegend)
                const ranges = getAllCommandsLocations(document)
                for (const range of ranges) {
                    const collectedData: ParseCollectedData = {}
                    // too slow! each command parse ~8-15ms
                    // easy to opt
                    fullCommandParse(document, range, range.start, collectedData, 'semanticHighlight')
                    for (const part of collectedData.partsSemanticTypes ?? []) {
                        builder.push(part[0], tempTokensMap[part[1]])
                    }
                }

                return builder.build()
            },
        },
        semanticLegend,
    )

    languages.registerSelectionRangeProvider(SUPPORTED_ALL_SELECTOR, {
        provideSelectionRanges(document, positions, token) {
            const ranges: SelectionRange[] = []
            for (const position of positions) {
                const commandRange = provideRangeFromDocumentPosition(document, position)
                if (!commandRange) continue
                const startPos = commandRange.start
                const text = document.getText(commandRange)
                const parseResult = parseCommandString(text, position.character - startPos.character, false)
                if (!parseResult) continue
                const { currentPartOffset, currentPartValue, allParts } = parseResult
                const curRange = new Range(
                    startPos.translate(0, currentPartOffset),
                    startPos.translate(0, fixEndingPos(text, currentPartOffset + currentPartValue.length)),
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

    // todo codeActions to shorten, unshorten options, subcommands (aliases)
}

const registerUpdateOnFileRename = () => {
    workspace.onDidRenameFiles(async ({ files: renamedFiles }) => {
        if (!getExtensionSetting('updatePathsOnFileRename')) return
        // todo done for demo purposes / don't make implicit edits
        const documentsToParse = window.visibleTextEditors.map(({ document }) => document).filter(document => isSupportedDocument(document))
        // const updateLocations
        const edit = new WorkspaceEdit()
        for (const document of documentsToParse) {
            const docTextEdits: TextEdit[] = []
            const ranges = getAllCommandsLocations(document)
            if (!ranges) continue
            for (const range of ranges) {
                const collectedData: ParseCollectedData = {}
                fullCommandParse(document, range, range.start, collectedData, 'path-parts')
                for (const part of collectedData.filePathParts ?? []) {
                    const docCwd = getCwdUri(document)!
                    const renamedFile = renamedFiles.find(({ oldUri }) => oldUri.toString() === Uri.joinPath(docCwd, part[0]).toString())
                    if (!renamedFile) continue
                    const newPath = renamedFile.newUri.path
                    const newRelativePath = relative(docCwd.path, newPath)
                    // todo1 preserve ./
                    docTextEdits.push({ range: part[3], newText: newRelativePath })
                }
            }
            if (docTextEdits.length > 0) edit.set(document.uri, docTextEdits)
        }
        if (edit.size) await workspace.applyEdit(edit)
    })
}

const registerLinter = () => {
    const diagnosticCollection = languages.createDiagnosticCollection('uniqueUnreleasedFig')
    let supportedDocuments = []
    const doLinting = (document: TextDocument) => {
        if (!getExtensionSetting('validate')) {
            diagnosticCollection.set(document.uri, [])
            return
        }
        const lintTypeToOptionMap: Partial<Record<LintProblemType, string>> = {
            commandName: 'commandName',
        }
        // use delta edit optimizations?
        const ranges = getAllCommandsLocations(document)
        const allLintProblems: ParseCollectedData['lintProblems'] = []
        for (const range of ranges) {
            const collectedData: ParseCollectedData = {}
            fullCommandParse(document, range, range.start, collectedData, 'lint')
            const { lintProblems } = collectedData
            allLintProblems.push(
                ...(lintProblems.filter(({ type }) => {
                    const controlledSetting = lintTypeToOptionMap[type]
                    if (!controlledSetting) return true
                    return getExtensionSetting(`lint.${controlledSetting}`)
                }) ?? []),
            )
        }
        diagnosticCollection.set(
            document.uri,
            allLintProblems.map(({ message, range, type }) => ({
                message,
                range: new Range(...range),
                severity: DiagnosticSeverity.Information,
                source: 'fig',
                // code
            })),
        )
    }
    const lintEditors = () => {
        // todo use tabs instead
        supportedDocuments = window.visibleTextEditors.map(({ document }) => document).filter(document => isSupportedDocument(document))
        for (const document of supportedDocuments) {
            doLinting(document)
        }
    }
    workspace.onDidChangeTextDocument(({ document }) => {
        // todo context changes: scripts
        if (!supportedDocuments.includes(document)) return
        doLinting(document)
    })
    lintEditors()
    window.onDidChangeVisibleTextEditors(lintEditors)
    workspace.onDidChangeConfiguration(({ affectsConfiguration }) => {
        if (['figUnreleased.validate', 'figUnreleased.lint.commandName'].some(key => affectsConfiguration(key))) lintEditors()
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
