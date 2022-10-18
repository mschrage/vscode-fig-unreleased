import {
    commands,
    CompletionList,
    ConfigurationTarget,
    Hover,
    languages,
    LocationLink,
    Position,
    Range,
    Selection,
    SignatureHelp,
    TextDocument,
    TextEditor,
    Uri,
    window,
    workspace,
    WorkspaceEdit,
} from 'vscode'

import { expect } from 'chai'
import delay from 'delay'
import { join } from 'path'
import { clearEditorText, getConfig, stringWithPositions } from './utils'
import _ from 'lodash'

describe('e2e', () => {
    let document: TextDocument
    let editor: TextEditor
    let initialPos: Position
    let startContent!: string

    before(async function () {
        this.timeout(6000)
        const testingPackageJsonUri = Uri.file(join(__dirname, '../fixtures/package.json'))
        await workspace.fs.writeFile(
            testingPackageJsonUri,
            new TextEncoder().encode(
                JSON.stringify(
                    {
                        scripts: {
                            extension_testing: '',
                        },
                    },
                    undefined,
                    2,
                ),
            ),
        )
        initialPos = new Position(2, 5 + 'extension_testing'.length + 4)
        await window.showTextDocument(testingPackageJsonUri, { selection: new Range(initialPos, initialPos) })
        editor = window.activeTextEditor!
        document = editor.document
        startContent = document.getText()
        await delay(200)
        await commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, initialPos)
        await delay(300)
    })

    const stringPos = (offset: number) => initialPos.translate(0, offset)
    const linePos = () => document.lineAt(initialPos)
    const setCursorPos = (position: Position) => {
        editor.selection = new Selection(position, position)
    }

    const resetDocument = async (startCommand: string) => {
        const insertOffset = document.offsetAt(initialPos)
        await clearEditorText(editor, startContent.slice(0, insertOffset) + startCommand + startContent.slice(insertOffset))
        setCursorPos(initialPos.translate(0, startCommand.length))
    }
    const getCommandText = () => {
        const lineEnd = linePos().range.end
        return document.getText(new Range(initialPos, lineEnd.translate(0, -1)))
    }
    const triggerSuggest = async (addDelay: boolean) => {
        await commands.executeCommand('editor.action.triggerSuggest')
        if (addDelay) await delay(500)
    }
    const acceptSuggest = () => commands.executeCommand('acceptSelectedSuggestion')

    const getCompletionsSorted = async function () {
        const completions: CompletionList = await commands.executeCommand('vscode.executeCompletionItemProvider', document, editor.selection.active)
        return _.sortBy(completions.items, c => c.sortText ?? c.label)
    }

    // to ensure that it just works
    it('Accepts any spec completion', async () => {
        await triggerSuggest(true)
        await acceptSuggest()
        expect(getCommandText().length).to.greaterThanOrEqual(1)
    })

    it('Sort text', async () => {
        await resetDocument('esbuild -')
        await triggerSuggest(true)
        await acceptSuggest()
        // --bundle goes first
        expect(getCommandText()).to.equal('esbuild --bundle')
    })

    it('Replace token by range', async () => {
        await resetDocument('esbuild --bundle')
        // es| -> eslint (replaces current token esbuild)
        const newPos = initialPos.translate(0, 2)
        editor.selection = new Selection(newPos, newPos)
        await triggerSuggest(true)
        await commands.executeCommand('selectNextSuggestion')
        await acceptSuggest()
        expect(getCommandText()).to.equal('eslint --bundle')
    })

    it('esbuild --target option: seperator & generator', async () => {
        await resetDocument('esbuild --target')
        await triggerSuggest(true)
        await acceptSuggest()
        // accept two values from custom generator
        await delay(300)
        await acceptSuggest()
        await commands.executeCommand('type', { text: ',' })
        // , trigger character, but let's retrigger
        await triggerSuggest(true)
        await acceptSuggest()
        expect(getCommandText()).to.equal('esbuild --target=chrome,chrome')
    })

    it('subcommand arg git generator', async () => {
        await resetDocument('git config --global user.')
        await triggerSuggest(true)
        await acceptSuggest()
        expect(getCommandText()).to.equal('git config --global user.email')
    })

    const testCase = (input: string) => {
        it(input, async () => {
            const [contents, positions] = stringWithPositions(input, ['(arg-compl)', '(arg)'])
            await resetDocument(contents)
            for (const pos of positions['(arg)']) {
                // ensure that have something
                await assertArgPosition(pos)
            }

            async function assertArgPosition(pos: number) {
                const help: SignatureHelp = await commands.executeCommand('vscode.executeSignatureHelpProvider', document.uri, stringPos(pos))
                expect(help.signatures[0].label.length).to.greaterThanOrEqual(1)
                const [hover]: Hover[] = await commands.executeCommand('vscode.executeHoverProvider', document.uri, stringPos(pos))
                const hoverContents = hover.contents[0]
                if (typeof hoverContents !== 'object') throw new Error('Expected hover markdown object')
                expect(hoverContents.value.startsWith('\\(arg\\)')).to.equal(true)
            }
        })
    }

    // todo test hover range

    describe('Suite cases', () => {
        // to make it .only, wrap with describe.only
        testCase('git checkout -b test test(arg) test(arg)')
    })

    const readableSelection = () => {
        const { selection } = editor
        const posReadable = ({ line, character }: Position) => `${line},${character}`
        return `${posReadable(selection.start)}-${posReadable(selection.end)}`
    }

    it('Range selection', async () => {
        const [contents, position] = stringWithPositions('tsc && esbuild --target|=test arg', ['|'])
        await resetDocument(contents)
        setCursorPos(stringPos(position['|'][0]))

        await commands.executeCommand('editor.action.smartSelect.expand')
        expect(readableSelection()).to.equal('2,43-2,49')
        await commands.executeCommand('editor.action.smartSelect.expand')
        expect(readableSelection()).to.equal('2,41-2,54')
        await commands.executeCommand('editor.action.smartSelect.expand')
        expect(readableSelection()).to.equal('2,33-2,58')
        await commands.executeCommand('editor.action.smartSelect.expand')
        expect(readableSelection()).to.equal('2,26-2,58')
    })

    const getExtDiagnostics = () => languages.getDiagnostics(document.uri).filter(diagnostic => diagnostic.source === 'fig')
    const testDiagnostics = (input: string, expectedMessages: string[]) => {
        it(input, async () => {
            const [contents, { '|': positions }] = stringWithPositions(input, ['|'])
            const ranges: Range[] = []
            for (const [i, pos] of positions.entries()) {
                if (i % 2 === 0) continue
                ranges.push(new Range(stringPos(positions[i - 1]), stringPos(pos)))
            }
            const diagnosticsChangePromise = getExtDiagnostics().length
                ? new Promise<void>(resolve => {
                      languages.onDidChangeDiagnostics(() => {
                          resolve()
                      })
                  })
                : Promise.resolve(null)
            await Promise.all([resetDocument(contents), diagnosticsChangePromise])
            const ourDiagnostics = getExtDiagnostics()
            expect(ourDiagnostics.length).to.equal(expectedMessages.length)
            for (const [i, { range, message }] of ourDiagnostics.entries()) {
                expect(range.isEqual(ranges[i])).to.equal(true)
                expect(expectedMessages[i]).to.equal(message)
            }
        })
    }

    describe('linting', () => {
        // testDiagnostics('|esint| --cache', ['Unknown command esint'])
        testDiagnostics('pnpm build |--prod|', ["Command doesn't take options here"])
        testDiagnostics('|jest| |--bali|', ['jest is not installed', 'Unknown option --bali Did you mean --bail?'])
        testDiagnostics('base64 |something|', ["base64 doesn't take argument here"])
    })

    describe('File paths', () => {
        let renamingExpectedFile: Uri
        it('Auto rename paths', async () => {
            const renamingFile = Uri.joinPath(document.uri, '../start.mjs')
            renamingExpectedFile = Uri.joinPath(document.uri, '../build.mjs')
            await getConfig().update('updatePathsOnFileRename', 'always', ConfigurationTarget.Global)
            await workspace.fs.writeFile(renamingFile, new TextEncoder().encode(''))
            await resetDocument('echo start.mjs && node start.mjs')
            const edit = new WorkspaceEdit()
            edit.renameFile(renamingFile, renamingExpectedFile)
            // todo extract to util like waitForEditorChanges
            await new Promise<void>(resolve => {
                workspace.applyEdit(edit)
                const { dispose } = workspace.onDidChangeTextDocument(() => {
                    resolve()
                    dispose()
                })
            })
            expect(getCommandText()).to.equal('echo start.mjs && node build.mjs')
        })

        it('Definition provider', async () => {
            // todo it relies on previous test
            const [{ targetUri }]: LocationLink[] = await commands.executeCommand(
                'vscode.executeDefinitionProvider',
                document.uri,
                linePos().range.end.translate(0, -1) /* pos of end of build.mjs */,
            )
            expect(targetUri.toString()).to.equal(renamingExpectedFile.toString())
            // todo test that previous part doesn't have definition
        })

        it('Rename provider: build.mjs -> start.mjs', async () => {
            // todo it relies on previous test
            const edit: WorkspaceEdit = await commands.executeCommand(
                'vscode.executeDocumentRenameProvider',
                document.uri,
                linePos().range.end.translate(0, -2) /* pos of end of build.mjs */,
                'start.mjs',
            )
            await new Promise<void>(resolve => {
                workspace.applyEdit(edit)
                const { dispose } = workspace.onDidChangeTextDocument(() => {
                    resolve()
                    dispose()
                })
            })
            await delay(300)
            const filesList = (await workspace.fs.readDirectory(Uri.joinPath(document.uri, '..'))).map(([name]) => name)
            expect(filesList).to.contain('start.mjs')
            expect(filesList).to.not.contain('build.mjs')
        })
    })
})
