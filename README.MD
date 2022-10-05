# FIG UNRELEASED

> Welcome!

## Contributing Providers

> Here, in quote I'm describing what is benefit of using Fig OSS autocomplete

### Completion

![1](media/completions.png)

### Hover

Giving a subcommand, argument or option description.

![2](media/hover.png)

### Definition

For now using only to quickly navigate (ctrl+click) to files, so
> Fig can tell, which argument is possibly a file path.

### Rename

> Fig can tell, which argument is possibly a file path.

Hit F2 to rename the file / change path in filesystem.

Note that this is the same as manual renaming in explorer, just a quicker way to do that.

### Selection Range

| Before                           | After                           |
| -------------------------------- | ------------------------------- |
| ![1](media/before-selection.gif) | ![1](media/after-selection.gif) |

### Semantic Highlighting

![2](media/semantic-highlighting.png)

### Linting

![1](media/lint.png)

Would be disabled by default.

- ideas/problems:
  - file path validation. Limitation: unknown when its okay to reference file that doesn't exist: generated (or maybe output?)
  - some subcommands/commands take any options. Examples: `node build.js --watch`, `webpack serve --mode`
  - arg validation from suggestions

### Update Paths on File Rename

![1](media/auto-rename-paths.gif)

### TODO

Inline all my deps
