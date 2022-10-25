//@ts-check
// patched version of shell-quote package to include indexes (offsets) of matches

// '<(' is process substitution operator and
// can be parsed the same as control operator
var CONTROL = '(?:' + ['\\|\\|', '\\&\\&', ';;', '\\|\\&', '\\<\\(', '>>', '>\\&', '[&;()|<>]'].join('|') + ')'
var META = '|&;()<> \\t'
var BAREWORD = '(\\\\[\'"' + META + ']|[^\\s\'"' + META + '])+'
var SINGLE_QUOTE = '"((\\\\"|[^"])*?)"'
var DOUBLE_QUOTE = "'((\\\\'|[^'])*?)'"

var TOKEN = ''
for (var i = 0; i < 4; i++) {
    TOKEN += (Math.pow(16, 8) * Math.random()).toString(16)
}

exports.parse = function (s) {
    return parse(s)
}

function parse(s) {
    var chunker = new RegExp(
        [
            '(' + CONTROL + ')', // control chars
            '(' + BAREWORD + '|' + SINGLE_QUOTE + '|' + DOUBLE_QUOTE + ')*',
        ].join('|'),
        'g',
    )
    var match = [...s.matchAll(chunker)].filter(([m]) => m)
    var commented = false

    if (!match) return []
    return (
        match
            .map(function (match, j) {
                if (commented) {
                    return
                }
                const s = match[0]
                if (RegExp('^' + CONTROL + '$').test(s)) {
                    return { op: s, index: match.index }
                }

                // Hand-written scanner/parser for Bash quoting rules:
                //
                //  1. inside single quotes, all characters are printed literally.
                //  2. inside double quotes, all characters are printed literally
                //     except variables prefixed by '$' and backslashes followed by
                //     either a double quote or another backslash.
                //  3. outside of any quotes, backslashes are treated as escape
                //     characters and not printed (unless they are themselves escaped)
                //  4. quote context can switch mid-token if there is no whitespace
                //     between the two quote contexts (e.g. all'one'"token" parses as
                //     "allonetoken")
                var SQ = "'"
                var DQ = '"'
                var DS = '$'
                var BS = '\\'
                var quote = false
                var esc = false
                var out = ''

                for (var i = 0, len = s.length; i < len; i++) {
                    var c = s.charAt(i)
                    if (esc) {
                        out += c
                        esc = false
                    } else if (quote) {
                        if (c === quote) {
                            quote = false
                            // @ts-ignore
                        } else if (quote == SQ) {
                            out += c
                        } else {
                            // Double quote
                            if (c === BS) {
                                i += 1
                                c = s.charAt(i)
                                if (c === DQ || c === BS || c === DS) {
                                    out += c
                                } else {
                                    out += BS + c
                                }
                            } else {
                                out += c
                            }
                        }
                    } else if (c === DQ || c === SQ) {
                        quote = c
                    } else if (RegExp('^' + CONTROL + '$').test(c)) {
                        return { op: s, index: match.index }
                    } else if (RegExp('^#$').test(c)) {
                        commented = true
                        if (out.length) {
                            // return [out, { comment: s.slice(i + 1) + match.slice(j + 1).join(' ') }]
                        } else {
                            return
                        }
                    } else if (c === BS) {
                        esc = true
                    } else out += c
                }

                return [out, match.index]
            })
    )
}
