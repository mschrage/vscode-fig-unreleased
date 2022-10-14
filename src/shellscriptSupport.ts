import { DocumentSelector, Range } from 'vscode'
import { API, RegisterLanguageSupportOptions } from './extension-api'

const SUPPORTED_SHELL_SELECTOR: DocumentSelector = ['bat', 'shellscript']

const shellBannedLineRegex = /^\s*(#|::|if|else|fi|return|function|"|'|[\w\d]+(=|\())/i

const options: RegisterLanguageSupportOptions = {
    provideSingleLineRangeFromPosition(document, position) {
        const line = document.lineAt(position)
        shellBannedLineRegex.lastIndex = 0
        if (shellBannedLineRegex.test(line.text)) return
        return line.range
    },
    getAllSingleLineCommandLocations(document) {
        const ranges: Range[] = []
        for (let lineNum = 0; lineNum < document.lineCount; lineNum++) {
            const { text, range } = document.lineAt(lineNum)
            shellBannedLineRegex.lastIndex = 0
            if (shellBannedLineRegex.test(text)) continue
            ranges.push(range)
        }
        return ranges
    },
    pathAutoRename: {
        glob: '*.sh,*.bat',
    },
}

export const registerShellSupport = (api: API) => {
    api.registerLanguageSupport(SUPPORTED_SHELL_SELECTOR, options)
}
