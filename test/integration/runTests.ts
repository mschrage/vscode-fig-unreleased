import { join } from 'path'
import { runTests } from '@vscode/test-electron'
import { emptydirSync } from 'fs-extra'

async function main() {
    try {
        const fixturesPath = join(__dirname, './fixtures')
        emptydirSync(fixturesPath)
        await runTests({
            version: 'stable',
            extensionDevelopmentPath: join(__dirname, '..'),
            extensionTestsPath: join(__dirname, './index'),
            launchArgs: [fixturesPath, '--disable-extensions'],
        })
    } catch (error) {
        console.error(error)
        console.error('Failed to run tests')
        process.exit(1)
    }
}

void main()
