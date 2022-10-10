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

exports.parse = function (s, env, opts) {
    return parse(s, env, opts)
}

function parse(s, env, opts) {
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
    if (!env) env = {}
    if (!opts) opts = {}
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
                var BS = opts.escape || '\\'
                var quote = false
                var esc = false
                var out = ''
                // var isGlob = false

                for (var i = 0, len = s.length; i < len; i++) {
                    var c = s.charAt(i)
                    // isGlob = isGlob || (!quote && (c === '*' || c === '?'))
                    if (esc) {
                        out += c
                        esc = false
                    } else if (quote) {
                        if (c === quote) {
                            quote = false
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
                            } else if (c === DS) {
                                out += parseEnvVar()
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
                    } else if (c === DS) {
                        out += parseEnvVar()
                    } else out += c
                }

                // if (isGlob) return { op: 'glob', index: match.index, pattern: out }

                return [out, match.index]

                function parseEnvVar() {
                    i += 1
                    var varend, varname
                    //debugger
                    if (s.charAt(i) === '{') {
                        i += 1
                        if (s.charAt(i) === '}') {
                            throw new Error('Bad substitution: ' + s.substr(i - 2, 3))
                        }
                        varend = s.indexOf('}', i)
                        if (varend < 0) {
                            throw new Error('Bad substitution: ' + s.substr(i))
                        }
                        varname = s.substr(i, varend - i)
                        i = varend
                    } else if (/[*@#?$!_\-]/.test(s.charAt(i))) {
                        varname = s.charAt(i)
                        i += 1
                    } else {
                        varend = s.substr(i).match(/[^\w\d_]/)
                        if (!varend) {
                            varname = s.substr(i)
                            i = s.length
                        } else {
                            varname = s.substr(i, varend.index)
                            i += varend.index - 1
                        }
                    }
                    return getVar(null, '', varname)
                }
            })
    )

    function getVar(_, pre, key) {
        var r = typeof env === 'function' ? env(key) : env[key]
        if (r === undefined && key != '') r = ''
        else if (r === undefined) r = '$'

        if (typeof r === 'object') {
            return pre + TOKEN + JSON.stringify(r) + TOKEN
        } else return pre + r
    }
}
