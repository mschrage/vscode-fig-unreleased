declare module 'FIG_ALL_SPECS' {
    const specs: { default: Fig.Spec }[]
    export default specs
}

// make builtin methods usable with TypeScript

type StringKeys<T extends object> = Extract<keyof T, string>

interface ObjectConstructor {
    keys<T extends object>(obj: T): StringKeys<T>[]
    entries<T extends object>(obj: T): [StringKeys<T>, T[keyof T]][]
    fromEntries<T extends [string, any][]>(obj: T): Record<T[number][0], T[number][1]>
}
