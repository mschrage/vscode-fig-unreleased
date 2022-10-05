/** Additional options for adding completions */
export interface CompletionAdditionalOptions {
    /**
     * For now matter for package.json scripts only. Set to false if package, containing the command should be installed locally first.
     * @default true
     */
    // isGlobal: boolean
    /** We will show code action to install this package if spec is missing. Requires `isGlobal` to be `false` */
    // proposePackage: string
}

export interface API {
    addCompletions(rootSubcommand: Fig.Subcommand, additionalOptions: CompletionAdditionalOptions = {}): void
    getCompletionsSpecs(): Fig.Subcommand[]
}
