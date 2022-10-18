/// <reference types="@withfig/autocomplete-types/index" />
import * as vsc from 'vscode'

type MaybePromise<T> = T | Promise<T>

/** Additional options for adding completions */
export interface CompletionAdditionalOptions {
    // todo1
    /**
     * For now matters for package.json scripts only. Set to false if package, containing the command should be installed locally first.
     * @default true
     */
    // isGlobal: boolean
    /** We will show code action to install this package if spec is missing. Requires `isGlobal` to be `false` */
    // proposePackage: string
}

export interface CustomCompletionItem extends vsc.CompletionItem {
    /** Use this check instead of kind == file as options can also be file kind to make icon look nice */
    isFileCompletion?: boolean
    completionType?: 'command' | 'arg' | 'subcommand' | 'option' | 'option-arg' | 'mixin' | 'shortcut'
}

/** Here you can override speficic feature (or provider) enablement / behavior */
export interface FeatureControl {
    /**
     * List of providers to disable
     * @default []
     */
    disableProviders?: ('rename' | 'rangeSelection' | 'hover' | 'signatureHelp' | 'definition')[]
    /**
     * @default true
     */
    enableCompletionProvider?:
        | boolean
        | {
              processCompletions?(completion: CustomCompletionItem[], info: { specName: string }): vsc.CompletionItem[]
          }
}

export interface RegisterLanguageSupportOptions {
    /** handle requesting position in document */
    provideSingleLineRangeFromPosition(document: vsc.TextDocument, position: vsc.Position): MaybePromise<vsc.Range | undefined>
    getAllSingleLineCommandLocations?(document: vsc.TextDocument): vsc.Range[] | undefined
    // todo implement
    /**
     * We don't do any caching of this method, so most probably you want to provide prepare result here
     * If undefined is returned, we skip executing script generators & displaying filepath suggestions
     * @default By default we provide cwd
     */
    // getCwd?(): vsc.Uri | undefined
    /**
     * Optionally add support for `updatePathsOnFileRename` feature
     * But note, that `getAllSingleLineCommandLocations` must be implemented to make it work
     */
    pathAutoRename?: {
        /**
         * Simple glob pattern that, that must not include `{` or `}`
         * It will get prefixed with **\/
         * @example `*.sh,*.bat` or `package.json`
         * @experimental
         */
        glob: string
    }
    /**
     * Wether the spec can be used in specific context (installed locally for example)
     * User can disable this
     */
    isSpecCanBeUsed?(specName: string, file: vsc.Uri): boolean | string
}

export interface API {
    addCompletionsSpec(rootSubcommand: Fig.Subcommand, additionalOptions: CompletionAdditionalOptions = {}): void
    getCompletionsSpecs(): readonly Fig.Subcommand[]
    // getLoadedCompletionSpecs
    registerLanguageSupport(
        selector: vsc.DocumentSelector,
        options: RegisterLanguageSupportOptions,
        featureControl: FeatureControl = {},
    ): { disposables: vsc.Disposable[] }

    /** Interface for working with general events */
    events: {
        fire(type: 'lint', documents: vsc.TextDocument[] | undefined): void

        onDidChangeSpecs: vsc.Event<void>
    }
}
