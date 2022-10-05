/** Additional options for adding completions */
export interface CompletionAdditionalOptions {
    /** We will show code action to install this package if spec is missing. Requires to set isGlobal parameter to `false` */
    // proposePackage: string
}

export interface API {
    /**
     * @param isGlobal Wether to use the command it should be installed locally first. Set to trueIt matters for package.json scripts, where we see
     */
    addCompletions(rootSubcommand: Fig.Subcommand, isGlobal = true, additionalOptions: CompletionAdditionalOptions = {}): void
    getCompletionsSpecs(): Fig.Subcommand[]
}
