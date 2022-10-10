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

const stringWithPositions = (contents: string) => {
    const cursorPositions = {} as Record<'$' | '|', number>
    const replacement = /[\|\$]/
    let currentMatch: RegExpExecArray | null | undefined
    while ((currentMatch = replacement.exec(contents))) {
        const offset = currentMatch.index
        const matchLength = currentMatch[0]!.length
        contents = contents.slice(0, offset) + contents.slice(offset + matchLength)
        cursorPositions[currentMatch[0]] = offset
    }
    return [contents, cursorPositions] as const
}

const parseCommandStringWithCursor = (input: string, sliceStr = false) => {
    const [str, { '|': cursor, $: partStart }] = stringWithPositions(input)
    return { ...(parseCommandString(str, cursor, sliceStr) ?? {}), partStart }
}

const testCommandPart = (input: string, expectedValue: string, expectedIndex?: number) => {
    test(`Command part: ${input}`, () => {
        const { currentPartValue, currentPartOffset, currentPartIndex, partStart } = parseCommandStringWithCursor(input) || {}
        expect(currentPartValue).toBe(expectedValue)
        expect(currentPartOffset).toBe(partStart)
        if (expectedIndex !== undefined) expect(currentPartIndex).toBe(expectedIndex)
    })
}

describe('parseCommandString', () => {
    // parseCommandString('spec *.vsix *.log arg'))

    test('Basic', () => {
        const { partStart: cursor, ...result } = parseCommandStringWithCursor('yarn &&  pnpm| test')
        expect(result?.allParts).toEqual([
            ['pnpm', 9, false],
            ['test', 14, false],
        ])
    })

    test('No empty parts', () => {
        const { partStart: cursor, ...result } = parseCommandStringWithCursor('| &&')
        expect(result?.allParts).toEqual([['', 0, false]])
    })

    test('Globs handling', () => {
        const { partStart: cursor, ...result } = parseCommandStringWithCursor('spec *.vsix *|.log arg')
        expect(result?.allParts).toEqual([
            ['spec', 0, false],
            ['*.vsix', 5, false],
            ['*.log', 12, false],
            ['arg', 18, false],
        ])
    })

    test('Trim', () => {
        const result = parseCommandStringWithCursor('esbuild "test 2.js" --define:|yes', true)
        expect(result?.currentPartValue).toBe('--define:')
    })

    // | - testing cursor position
    // $ - expected part position
    testCommandPart('$|', '', 0)
    testCommandPart('$| some-args', '', 0)
    testCommandPart('yarn && pnpm $|test', 'test', 1)
    testCommandPart('esbuild "test 2.js" $--define:yes|', '--define:yes', 2)
    testCommandPart('$esbui|ld "test 2.js" --define:yes ', 'esbuild', 0)
    testCommandPart('$|esbuild "test 2.js" --define:yes', 'esbuild', 0)
    testCommandPart('$esbuild| "test 2.js" --define:yes', 'esbuild', 0)
    testCommandPart('esbuild test $|', '', 2)
    testCommandPart('esbuild test $| --test', '', 2)
    testCommandPart('esbuild $"--opt=|value " --define:yes ', '--opt=value ', 1)
    testCommandPart('esbuild $--allow-|overwrite ', '--allow-overwrite', 1)
    testCommandPart('esbuild "v" $--allow-overwrite| ', '--allow-overwrite', 2)
    testCommandPart('esbuild $" a | b"', ' a  b', 1)
    testCommandPart('eslint && $|', '', 0)
    testCommandPart('eslint $|&& yarn', '', 1)
    testCommandPart('eslint $| && yarn', '', 1)
    testCommandPart('eslint && $| &&', '', 0)
    // todo
    // testCommandPart('eslint &&$|&&', '', 0)
    testCommandPart('eslint && eslint $| &&', '', 1)
    testCommandPart('esbuild "v" --allow-overwrite $|', '', 3)
})

// describe('getDocumentParsedResult', () => {

describe('Real test', () => {
    test.todo('git switch -b test(arg) test(arg) test(arg)')
    test.todo('git config test(arg-compl) --global')
    test.todo('git config --global test(arg-compl)')
    test.todo('git esbuild (arg) test(arg-compl)')
})
