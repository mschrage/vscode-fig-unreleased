import { fsExists } from '@zardoy/vscode-utils/build/fs'
import * as vscode from 'vscode'
import { relative } from 'path-browserify'

// finds all package.json files until reaches the root (even if in workspace to support monorepos strat)
export const findUpMultiplePackageJson = async (cwd: vscode.Uri): Promise<vscode.Uri[]> => {
    console.time('find package.json')
    try {
        const currentWorkspacePath = vscode.workspace.getWorkspaceFolder(cwd)
        if (!currentWorkspacePath) return []
        const foundUris: vscode.Uri[] = []

        let currentBaseUri = cwd
        while (true) {
            const currentCheckUri = vscode.Uri.joinPath(currentBaseUri, 'package.json')
            if (await fsExists(currentCheckUri, true)) {
                foundUris.push(currentCheckUri)
            }
            if (relative(currentBaseUri.path, currentWorkspacePath.uri.path) === '') {
                break
            }

            currentBaseUri = vscode.Uri.joinPath(currentBaseUri, '..')
        }

        return foundUris
    } finally {
        console.timeEnd('find package.json')
    }
}
