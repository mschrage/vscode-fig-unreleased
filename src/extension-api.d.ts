/// <reference types="@withfig/autocomplete-types/index" />
import * as vsc from 'vscode'

type MaybePromise<T> = T | Promise<T>

/** Additional options for adding completions */
export interface CompletionAdditionalOptions {
    // todo1
    /**
     * For now matter for package.json scripts only. Set to false if package, containing the command should be installed locally first.
     * @default true
     */
    // isGlobal: boolean
    /** We will show code action to install this package if spec is missing. Requires `isGlobal` to be `false` */
    // proposePackage: string
}

export interface FeatureControl {
    // todo1
    disable?
}

export interface RegisterLanguageSupportOptions {
    /** handle requesting position in document */
    provideSingleLineRangeFromPosition(document: vsc.TextDocument, position: vsc.Position): MaybePromise<vsc.Range | undefined>
    getAllSingleLineCommandLocations?(document: vsc.TextDocument): vsc.Range[] | undefined
    // todo1
    /**
     * We don't do any caching of this method, so most probably you want to provide prepare result here
     * If undefined is returned, we skip executing script generators & displaying filepath suggestions
     * @default By default we provide cwd
     */
    getCwd?(): vsc.Uri | undefined
}

export interface API {
    addCompletions(rootSubcommand: Fig.Subcommand, additionalOptions: CompletionAdditionalOptions = {}): void
    getCompletionsSpecs(): Fig.Subcommand[]
    registerLanguageSupport(
        selector: vsc.DocumentSelector,
        options: RegisterLanguageSupportOptions,
        featureControl: FeatureControl = {},
    ): { disposables: vsc.Disposable[] }
}
