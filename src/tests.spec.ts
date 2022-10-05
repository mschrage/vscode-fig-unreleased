/// <reference types="vitest/globals" />

vi.mock('vscode', () => ({
    commands: {
        registerCommand() {},
    },
    languages: new Proxy(
        {},
        {
            get(target, p, receiver) {
                return () => {}
            },
        },
    ),
    workspace: {
        registerFileSystemProvider() {},
        onDidRenameFiles() {},
    },
    window: {
        onDidChangeTextEditorSelection() {},
        onDidChangeActiveTextEditor() {},
    },
    SemanticTokensLegend: class {},
}))

vi.mock('FIG_ALL_SPECS', () => ({ default: [] }))

globalThis.trackDisposable = a => a
globalThis.__TEST = true

import { parseCommandString } from './extension'

const stringWithCursor = (inputString: string, cursorMarker = '|') => {
    const idx = inputString.indexOf(cursorMarker)
    return [inputString.slice(0, idx) + inputString.slice(idx + 1), idx] as const
}

const parseCommandStringWithCursor = (input: string, sliceStr = false) => {
    const [str, cursor] = stringWithCursor(input)
    return parseCommandString(str, cursor, sliceStr)
}

const testCommandPart = (input: string, expectedValue: string, expectedOffset: number, expectedIndex?: number) => {
    test(`Command part: ${input}`, () => {
        const { currentPartValue, currentPartOffset, currentPartIndex } = parseCommandStringWithCursor(input) || {}
        expect(currentPartValue).toBe(expectedValue)
        expect(currentPartOffset).toBe(expectedOffset)
        if (expectedIndex !== undefined) expect(currentPartIndex).toBe(expectedIndex)
    })
}

describe('parseCommandString', () => {
    test('Basic', () => {
        const result = parseCommandStringWithCursor('yarn &&  pnpm| test')
        expect(result?.allParts).toEqual([
            ['pnpm', 9, false],
            ['test', 14, false],
        ])
    })

    test('Trim', () => {
        const result = parseCommandStringWithCursor('esbuild "test 2.js" --define:|yes', true)
        expect(result?.currentPartValue).toBe('--define:')
    })

    testCommandPart('|', '', 0, 0)
    testCommandPart('yarn && pnpm |test', 'test', 13, 1)
    testCommandPart('esbuild "test 2.js" --define:yes|', '--define:yes', 20, 2)
    testCommandPart('esbui|ld "test 2.js" --define:yes ', 'esbuild', 0, 0)
    testCommandPart('|esbuild "test 2.js" --define:yes', 'esbuild', 0, 0)
    testCommandPart('esbuild| "test 2.js" --define:yes', 'esbuild', 0, 0)
    testCommandPart('esbuild "--opt=|value " --define:yes ', '--opt=value ', 8, 1)
    testCommandPart('esbuild --allow-|overwrite ', '--allow-overwrite', 8, 1)
    testCommandPart('esbuild "v" --allow-overwrite| ', '--allow-overwrite', 12, 2)
    testCommandPart('eslint && |', '', 7, 0)
    testCommandPart('eslint && | &&', '', 7, 0)
    testCommandPart('eslint && eslint | &&', ' ', 16, 1)
    testCommandPart('esbuild "v" --allow-overwrite |', ' ', 29, 3)
})

// describe('getDocumentParsedResult', () => {

describe('Real test', () => {
    test.todo('git switch -b test(arg) test(arg) test(arg)')
    test.todo('git config test(arg-compl) --global')
    test.todo('git config --global test(arg-compl)')
    test.todo('git esbuild (arg) test(arg-compl)')
})
