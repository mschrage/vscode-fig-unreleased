# API

### Getting API

1. Copy [./src/extension-api.d.ts](./src/extension-api.d.ts) to your project
2. Add import to API like `import FigAPI from './extension-api.d.ts`, alternative you can wrap API contents with global namespace
3. Add code to use the API like this:

```ts
const figExtension = vscode.extensions.getExtension('undefined_publisher.fig-unreleased')
if (!figExtension) return
const api: FigAPI = await figExtension.activate()
```

Please, call `.activate()` when one of the methods are actually going to be used.

### Contribute Language Support

*Example:*

```ts
api.registerLanguageSupport(
   'xml',
   {
      async provideSingleLineRangeFromPosition(doc: vscode.TextDocument, position: vscode.Position) {
       // validate position
       // if good, return range containing current command like `cd .. && yarn --prod`
      },
   }
)
```

It's also recommended to provide `getAllSingleLineCommandLocations` and `pathAutoRename` implementations (see API).

It is also possible that contributing providers can conflict with existing providers. An example could be rename provider. In this case you can specify which providers should be disabled for contributing language with third argument like this: `{ disableProviders: ['rename'] }`

### Add Your Specs

*Example:*

```ts
api.addCompletionsSpec({
    name: 'my-command',
    options: [
        {
            name: '--flag'
        }
    ],
    args: {/* ... */}
})
```

### Reuse Extension Specs

You can benefit from extension specs updates and from other extensions contributing their specs.

```ts
const specs = api.getCompletionsSpecs()
```

You most probably want to install `@withfig/autocomplete-types` to get types of each spec.
