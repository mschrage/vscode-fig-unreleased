import { build, analyzeMetafile } from 'esbuild'
import { default as figSpecFileNames, diffVersionedCompletions } from '@withfig/autocomplete/build/index.js'

const dev = process.argv.includes('--watch')

const { metafile } = await build({
    bundle: true,
    logLevel: 'info',
    entryPoints: ['src/extension.ts'],
    mainFields: ['module', 'main'],
    platform: 'browser',
    format: 'cjs',
    external: ['vscode'],
    treeShaking: true,
    outfile: 'out/index.js',
    sourcemap: dev,
    watch: dev,
    keepNames: dev,
    minify: !dev,
    metafile: true,
    plugins: [
        {
            name: 'import-all-specs',
            setup(build) {
                const specFileNames = figSpecFileNames.filter(name => !diffVersionedCompletions.includes(name) && !name.includes('/'))
                const namespace = 'FIG_ALL_SPECS'
                build.onResolve({ filter: new RegExp(`^${namespace}$`) }, () => {
                    return {
                        namespace,
                        path: namespace,
                    }
                })
                build.onLoad({ filter: /.*/, namespace }, async () => {
                    return {
                        contents: `export default [${specFileNames.map(name => `require('@withfig/autocomplete/build/${name}')`).join(',')}]`,
                        loader: 'ts',
                        resolveDir: '.',
                    }
                })
            },
        },
    ],
})

// console.log(await analyzeMetafile(metafile))
