export const stringIconMap = {
    'fig://icon?type=yarn': 'yarn.lock',
    'fig://icon?type=npm': 'package.json',
    'ffig://icon?type=git': '.gitkeep',
}

// affects spec name + options
export const specGlobalIconMap: Record<string, string[]> = {
    '{name}.ts': ['esbuild'],
    '{name}.config.ts': ['vite', 'vitest', 'jest', 'webpack'],
    '.{name}rc': ['eslint', 'prettier'],
    'tailwind.config.ts': ['tailwindcss'],
}
