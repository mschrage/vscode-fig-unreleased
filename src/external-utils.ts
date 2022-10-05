import * as vsc from 'vscode'
import { join } from 'path-browserify'
import findUp from 'find-up'

const unimplementedSettings = {
    searchLocation: 'allUp' as 'nearest' | 'allUp',
}

// todo implement support for the web
// it is possible, but not sure that needed
export const getBinCommands = async (document: vsc.TextDocument) => {
    const documentPath = vsc.window.activeTextEditor?.document.uri.fsPath

    const nodeModulesPaths = await (async () => {
        if (documentPath) {
            const findUpArgs = [
                'node_modules',
                {
                    cwd: documentPath,
                    // stopAt: vsc.workspace.workspaceFolders?.[0]!.uri.fsPath,
                    type: 'directory',
                },
            ] as const
            if (unimplementedSettings.searchLocation === 'nearest') {
                const path = await findUp(...findUpArgs)
                return path !== undefined && [path]
            }

            return findUpMultiple(...findUpArgs)
        }

        const nodeModulesPath = join(workspacePath, 'node_modules')
        if (fs.existsSync(nodeModulesPath)) return [nodeModulesPath]
        return []
    })()
    if (!nodeModulesPaths || nodeModulesPaths.length === 0) throw new Error('no node_modules in current workspace')

    const showDescription = nodeModulesPaths.length > 0

    const result = await Promise.all(
        nodeModulesPaths.map(async dirPath =>
            (async (): Promise<VSCodeQuickPickItem[]> => {
                const binList = await fs.promises.readdir(join(dirPath, '.bin'))
                return binList
                    .filter(name => !/.(CMD|ps1)$/.test(name))
                    .map(name => ({
                        label: name,
                        value: name,
                        // TODO relative
                        description: showDescription ? dirPath : undefined,
                    }))
            })(),
        ),
    )
    return result.flat()
}
