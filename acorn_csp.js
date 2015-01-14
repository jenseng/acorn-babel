// Acorn is a tiny, fast JavaScript parser written in JavaScript.
//
// Acorn was written by Marijn Haverbeke and various contributors and
// released under an MIT license. The Unicode regexps (for identifiers
// and whitespace) were taken from [Esprima](http://esprima.org) by
// Ariya Hidayat.
//
// Git repositories for Acorn are available at
//
//     http://marijnhaverbeke.nl/git/acorn
//     https://github.com/marijnh/acorn.git
//
// Please use the [github bug tracker][ghbt] to report issues.
//
// [ghbt]: https://github.com/marijnh/acorn/issues
//
// This file defines the main parser interface. The library also comes
// with a [error-tolerant parser][dammit] and an
// [abstract syntax tree walker][walk], defined in other files.
//
// [dammit]: acorn_loose.js
// [walk]: util/walk.js

(function(root, mod) {
  if (typeof exports == "object" && typeof module == "object") return mod(exports); // CommonJS
  if (typeof define == "function" && define.amd) return define(["exports"], mod); // AMD
  mod(root.acorn || (root.acorn = {})); // Plain browser env
})(this, function(exports) {
  "use strict";

  exports.version = "0.11.1";

  // The main exported interface (under `self.acorn` when in the
  // browser) is a `parse` function that takes a code string and
  // returns an abstract syntax tree as specified by [Mozilla parser
  // API][api], with the caveat that inline XML is not recognized.
  //
  // [api]: https://developer.mozilla.org/en-US/docs/SpiderMonkey/Parser_API

  var options, input, inputLen, sourceFile;

  exports.parse = function(inpt, opts) {
    input = String(inpt); inputLen = input.length;
    setOptions(opts);
    initTokenState();
    var startPos = options.locations ? [tokPos, curPosition()] : tokPos;
    initParserState();
    return parseTopLevel(options.program || startNodeAt(startPos));
  };

  // A second optional argument can be given to further configure
  // the parser process. These options are recognized:

  var defaultOptions = exports.defaultOptions = {
    playground: false,
    // `ecmaVersion` indicates the ECMAScript version to parse. Must
    // be either 3, or 5, or 6. This influences support for strict
    // mode, the set of reserved words, support for getters and
    // setters and other features.
    ecmaVersion: 5,
    // Turn on `strictSemicolons` to prevent the parser from doing
    // automatic semicolon insertion.
    strictSemicolons: false,
    // When `allowTrailingCommas` is false, the parser will not allow
    // trailing commas in array and object literals.
    allowTrailingCommas: true,
    // By default, reserved words are not enforced. Enable
    // `forbidReserved` to enforce them. When this option has the
    // value "everywhere", reserved words and keywords can also not be
    // used as property names.
    forbidReserved: false,
    // When enabled, a return at the top level is not considered an
    // error.
    allowReturnOutsideFunction: false,
    // When enabled, import/export statements are not constrained to
    // appearing at the top of the program.
    allowImportExportEverywhere: false,
    // When enabled, hashbang directive in the beginning of file
    // is allowed and treated as a line comment.
    allowHashBang: false,
    // When `locations` is on, `loc` properties holding objects with
    // `start` and `end` properties in `{line, column}` form (with
    // line being 1-based and column 0-based) will be attached to the
    // nodes.
    locations: false,
    // A function can be passed as `onToken` option, which will
    // cause Acorn to call that function with object in the same
    // format as tokenize() returns. Note that you are not
    // allowed to call the parser from the callback—that will
    // corrupt its internal state.
    onToken: null,
    // A function can be passed as `onComment` option, which will
    // cause Acorn to call that function with `(block, text, start,
    // end)` parameters whenever a comment is skipped. `block` is a
    // boolean indicating whether this is a block (`/* */`) comment,
    // `text` is the content of the comment, and `start` and `end` are
    // character offsets that denote the start and end of the comment.
    // When the `locations` option is on, two more parameters are
    // passed, the full `{line, column}` locations of the start and
    // end of the comments. Note that you are not allowed to call the
    // parser from the callback—that will corrupt its internal state.
    onComment: null,
    // Nodes have their start and end characters offsets recorded in
    // `start` and `end` properties (directly on the node, rather than
    // the `loc` object, which holds line/column data. To also add a
    // [semi-standardized][range] `range` property holding a `[start,
    // end]` array with the same numbers, set the `ranges` option to
    // `true`.
    //
    // [range]: https://bugzilla.mozilla.org/show_bug.cgi?id=745678
    ranges: false,
    // It is possible to parse multiple files into a single AST by
    // passing the tree produced by parsing the first file as
    // `program` option in subsequent parses. This will add the
    // toplevel forms of the parsed file to the `Program` (top) node
    // of an existing parse tree.
    program: null,
    // When `locations` is on, you can pass this to record the source
    // file in every node's `loc` object.
    sourceFile: null,
    // This value, if given, is stored in every node, whether
    // `locations` is on or off.
    directSourceFile: null,
    // When enabled, parenthesized expressions are represented by
    // (non-standard) ParenthesizedExpression nodes
    preserveParens: false
  };

  // This function tries to parse a single expression at a given
  // offset in a string. Useful for parsing mixed-language formats
  // that embed JavaScript expressions.

  exports.parseExpressionAt = function(inpt, pos, opts) {
    input = String(inpt); inputLen = input.length;
    setOptions(opts);
    initTokenState(pos);
    initParserState();
    return parseExpression();
  };

  var isArray = function (obj) {
    return Object.prototype.toString.call(obj) === "[object Array]";
  };

  function setOptions(opts) {
    options = {};
    for (var opt in defaultOptions)
      options[opt] = opts && has(opts, opt) ? opts[opt] : defaultOptions[opt];
    sourceFile = options.sourceFile || null;
    if (isArray(options.onToken)) {
      var tokens = options.onToken;
      options.onToken = function (token) {
        tokens.push(token);
      };
    }
    if (isArray(options.onComment)) {
      var comments = options.onComment;
      options.onComment = function (block, text, start, end, startLoc, endLoc) {
        var comment = {
          type: block ? 'Block' : 'Line',
          value: text,
          start: start,
          end: end
        };
        if (options.locations) {
          comment.loc = new SourceLocation();
          comment.loc.start = startLoc;
          comment.loc.end = endLoc;
        }
        if (options.ranges)
          comment.range = [start, end];
        comments.push(comment);
      };
    }
    if (options.strictMode) {
      strict = true;
    }
    if (options.ecmaVersion >= 6) {
      isKeyword = isEcma6Keyword;
    } else {
      isKeyword = isEcma5AndLessKeyword;
    }
  }

  // The `getLineInfo` function is mostly useful when the
  // `locations` option is off (for performance reasons) and you
  // want to find the line/column position for a given character
  // offset. `input` should be the code string that the offset refers
  // into.

  var getLineInfo = exports.getLineInfo = function(input, offset) {
    for (var line = 1, cur = 0;;) {
      lineBreak.lastIndex = cur;
      var match = lineBreak.exec(input);
      if (match && match.index < offset) {
        ++line;
        cur = match.index + match[0].length;
      } else break;
    }
    return {line: line, column: offset - cur};
  };

  function Token() {
    this.type = tokType;
    this.value = tokVal;
    this.start = tokStart;
    this.end = tokEnd;
    if (options.locations) {
      this.loc = new SourceLocation();
      this.loc.end = tokEndLoc;
      // TODO: remove in next major release
      this.startLoc = tokStartLoc;
      this.endLoc = tokEndLoc;
    }
    if (options.ranges)
      this.range = [tokStart, tokEnd];
  }

  exports.Token = Token;

  // Acorn is organized as a tokenizer and a recursive-descent parser.
  // The `tokenize` export provides an interface to the tokenizer.
  // Because the tokenizer is optimized for being efficiently used by
  // the Acorn parser itself, this interface is somewhat crude and not
  // very modular. Performing another parse or call to `tokenize` will
  // reset the internal state, and invalidate existing tokenizers.

  exports.tokenize = function(inpt, opts) {
    input = String(inpt); inputLen = input.length;
    setOptions(opts);
    initTokenState();
    skipSpace();

    function getToken(forceRegexp) {
      lastEnd = tokEnd;
      readToken(forceRegexp);
      return new Token();
    }
    getToken.jumpTo = function(pos, reAllowed) {
      tokPos = pos;
      if (options.locations) {
        tokCurLine = 1;
        tokLineStart = lineBreak.lastIndex = 0;
        var match;
        while ((match = lineBreak.exec(input)) && match.index < pos) {
          ++tokCurLine;
          tokLineStart = match.index + match[0].length;
        }
      }
      tokRegexpAllowed = reAllowed;
      skipSpace();
    };
    getToken.noRegexp = function() {
      tokRegexpAllowed = false;
    };
    getToken.options = options;
    return getToken;
  };

  // State is kept in (closure-)global variables. We already saw the
  // `options`, `input`, and `inputLen` variables above.

  // The current position of the tokenizer in the input.

  var tokPos;

  // The start and end offsets of the current token.

  var tokStart, tokEnd;

  // When `options.locations` is true, these hold objects
  // containing the tokens start and end line/column pairs.

  var tokStartLoc, tokEndLoc;

  // The type and value of the current token. Token types are objects,
  // named by variables against which they can be compared, and
  // holding properties that describe them (indicating, for example,
  // the precedence of an infix operator, and the original name of a
  // keyword token). The kind of value that's held in `tokVal` depends
  // on the type of the token. For literals, it is the literal value,
  // for operators, the operator name, and so on.

  var tokType, tokVal;

  // Internal state for the tokenizer. To distinguish between division
  // operators and regular expressions, it remembers whether the last
  // token was one that is allowed to be followed by an expression.
  // (If it is, a slash is probably a regexp, if it isn't it's a
  // division operator. See the `parseStatement` function for a
  // caveat.)

  var tokRegexpAllowed;

  // When `options.locations` is true, these are used to keep
  // track of the current line, and know when a new line has been
  // entered.

  var tokCurLine, tokLineStart;

  // These store the position of the previous token, which is useful
  // when finishing a node and assigning its `end` position.

  var lastStart, lastEnd, lastEndLoc;

  // This is the parser's state. `inFunction` is used to reject
  // `return` statements outside of functions, `inGenerator` to
  // reject `yield`s outside of generators, `labels` to verify
  // that `break` and `continue` have somewhere to jump to, and
  // `strict` indicates whether strict mode is on.

  var inFunction, inGenerator, inAsync, labels, strict,
    inXJSChild, inXJSTag, inType;

  // This counter is used for checking that arrow expressions did
  // not contain nested parentheses in argument list.

  var metParenL;

  // This is used by the tokenizer to track the template strings it is
  // inside, and count the amount of open braces seen inside them, to
  // be able to switch back to a template token when the } to match ${
  // is encountered. It will hold an array of integers.

  var templates;

  function initParserState() {
    lastStart = lastEnd = tokPos;
    if (options.locations) lastEndLoc = new Position;
    inFunction = inGenerator = inAsync = strict = false;
    labels = [];
    skipSpace();
    readToken();
  }

  // This function is used to raise exceptions on parse errors. It
  // takes an offset integer (into the current `input`) to indicate
  // the location of the error, attaches the position to the end
  // of the error message, and then raises a `SyntaxError` with that
  // message.

  function raise(pos, message) {
    var loc = getLineInfo(input, pos);
    message += " (" + loc.line + ":" + loc.column + ")";
    var err = new SyntaxError(message);
    err.pos = pos; err.loc = loc; err.raisedAt = tokPos;
    throw err;
  }

  // Reused empty array added for node fields that are always empty.

  var empty = [];

  // ## Token types

  // The assignment of fine-grained, information-carrying type objects
  // allows the tokenizer to store the information it has about a
  // token in a way that is very cheap for the parser to look up.

  // All token type variables start with an underscore, to make them
  // easy to recognize.

  // These are the general types. The `type` property is only used to
  // make them recognizeable when debugging.

  var _num = {type: "num"}, _regexp = {type: "regexp"}, _string = {type: "string"};
  var _name = {type: "name"}, _eof = {type: "eof"};

  // These are JSX-specific token types

  var _xjsName = {type: "xjsName"}, _xjsText = {type: "xjsText"};

  // Keyword tokens. The `keyword` property (also used in keyword-like
  // operators) indicates that the token originated from an
  // identifier-like word, which is used when parsing property names.
  //
  // The `beforeExpr` property is used to disambiguate between regular
  // expressions and divisions. It is set on all token types that can
  // be followed by an expression (thus, a slash after them would be a
  // regular expression).
  //
  // `isLoop` marks a keyword as starting a loop, which is important
  // to know when parsing a label, in order to allow or disallow
  // continue jumps to that label.

  var _break = {keyword: "break"}, _case = {keyword: "case", beforeExpr: true}, _catch = {keyword: "catch"};
  var _continue = {keyword: "continue"}, _debugger = {keyword: "debugger"}, _default = {keyword: "default"};
  var _do = {keyword: "do", isLoop: true}, _else = {keyword: "else", beforeExpr: true};
  var _finally = {keyword: "finally"}, _for = {keyword: "for", isLoop: true}, _function = {keyword: "function"};
  var _if = {keyword: "if"}, _return = {keyword: "return", beforeExpr: true}, _switch = {keyword: "switch"};
  var _throw = {keyword: "throw", beforeExpr: true}, _try = {keyword: "try"}, _var = {keyword: "var"};
  var _let = {keyword: "let"}, _const = {keyword: "const"};
  var _while = {keyword: "while", isLoop: true}, _with = {keyword: "with"}, _new = {keyword: "new", beforeExpr: true};
  var _this = {keyword: "this"};
  var _class = {keyword: "class"}, _extends = {keyword: "extends", beforeExpr: true};
  var _export = {keyword: "export"}, _import = {keyword: "import"};
  var _yield = {keyword: "yield", beforeExpr: true};

  // The keywords that denote values.

  var _null = {keyword: "null", atomValue: null}, _true = {keyword: "true", atomValue: true};
  var _false = {keyword: "false", atomValue: false};

  // Some keywords are treated as regular operators. `in` sometimes
  // (when parsing `for`) needs to be tested against specifically, so
  // we assign a variable name to it for quick comparing.

  var _in = {keyword: "in", binop: 7, beforeExpr: true};

  // Map keyword names to token types.

  var keywordTypes = {"break": _break, "case": _case, "catch": _catch,
                      "continue": _continue, "debugger": _debugger, "default": _default,
                      "do": _do, "else": _else, "finally": _finally, "for": _for,
                      "function": _function, "if": _if, "return": _return, "switch": _switch,
                      "throw": _throw, "try": _try, "var": _var, "let": _let, "const": _const,
                      "while": _while, "with": _with,
                      "null": _null, "true": _true, "false": _false, "new": _new, "in": _in,
                      "instanceof": {keyword: "instanceof", binop: 7, beforeExpr: true}, "this": _this,
                      "typeof": {keyword: "typeof", prefix: true, beforeExpr: true},
                      "void": {keyword: "void", prefix: true, beforeExpr: true},
                      "delete": {keyword: "delete", prefix: true, beforeExpr: true},
                      "class": _class, "extends": _extends,
                      "export": _export, "import": _import, "yield": _yield};

  // Punctuation token types. Again, the `type` property is purely for debugging.

  var _bracketL = {type: "[", beforeExpr: true}, _bracketR = {type: "]"}, _braceL = {type: "{", beforeExpr: true};
  var _braceR = {type: "}"}, _parenL = {type: "(", beforeExpr: true}, _parenR = {type: ")"};
  var _comma = {type: ",", beforeExpr: true}, _semi = {type: ";", beforeExpr: true};
  var _colon = {type: ":", beforeExpr: true}, _dot = {type: "."}, _question = {type: "?", beforeExpr: true};
  var _arrow = {type: "=>", beforeExpr: true}, _bquote = {type: "`"}, _dollarBraceL = {type: "${", beforeExpr: true};
  var _ltSlash = {type: "</"};
  var _arrow = {type: "=>", beforeExpr: true}, _template = {type: "template"}, _templateContinued = {type: "templateContinued"};
  var _ellipsis = {type: "...", prefix: true, beforeExpr: true};
  var _paamayimNekudotayim = { type: "::", beforeExpr: true };
  var _at = { type: '@' };
  var _hash = { type: '#' };

  // Operators. These carry several kinds of properties to help the
  // parser use them properly (the presence of these properties is
  // what categorizes them as operators).
  //
  // `binop`, when present, specifies that this operator is a binary
  // operator, and will refer to its precedence.
  //
  // `prefix` and `postfix` mark the operator as a prefix or postfix
  // unary operator. `isUpdate` specifies that the node produced by
  // the operator should be of type UpdateExpression rather than
  // simply UnaryExpression (`++` and `--`).
  //
  // `isAssign` marks all of `=`, `+=`, `-=` etcetera, which act as
  // binary operators with a very low precedence, that should result
  // in AssignmentExpression nodes.

  var _slash = {binop: 10, beforeExpr: true}, _eq = {isAssign: true, beforeExpr: true};
  var _assign = {isAssign: true, beforeExpr: true};
  var _incDec = {postfix: true, prefix: true, isUpdate: true}, _prefix = {prefix: true, beforeExpr: true};
  var _logicalOR = {binop: 1, beforeExpr: true};
  var _logicalAND = {binop: 2, beforeExpr: true};
  var _bitwiseOR = {binop: 3, beforeExpr: true};
  var _bitwiseXOR = {binop: 4, beforeExpr: true};
  var _bitwiseAND = {binop: 5, beforeExpr: true};
  var _equality = {binop: 6, beforeExpr: true};
  var _relational = {binop: 7, beforeExpr: true};
  var _bitShift = {binop: 8, beforeExpr: true};
  var _plusMin = {binop: 9, prefix: true, beforeExpr: true};
  var _modulo = {binop: 10, beforeExpr: true};

  // '*' may be multiply or have special meaning in ES6
  var _star = {binop: 10, beforeExpr: true};
  var _exponent = {binop: 11, beforeExpr: true};

  // '<', '>' may be relational or have special meaning in JSX
  var _lt = {binop: 7, beforeExpr: true}, _gt = {binop: 7, beforeExpr: true};

  // Provide access to the token types for external users of the
  // tokenizer.

  exports.tokTypes = {bracketL: _bracketL, bracketR: _bracketR, braceL: _braceL, braceR: _braceR,
                      parenL: _parenL, parenR: _parenR, comma: _comma, semi: _semi, colon: _colon,
                      dot: _dot, ellipsis: _ellipsis, question: _question, slash: _slash, eq: _eq,
                      name: _name, eof: _eof, num: _num, regexp: _regexp, string: _string,
                      arrow: _arrow, bquote: _bquote, dollarBraceL: _dollarBraceL, star: _star,
                      assign: _assign, xjsName: _xjsName, xjsText: _xjsText,
                      paamayimNekudotayim: _paamayimNekudotayim, exponent: _exponent, at: _at, hash: _hash,
                      template: _template, templateContinued: _templateContinued};
  for (var kw in keywordTypes) exports.tokTypes["_" + kw] = keywordTypes[kw];

  // This is a trick taken from Esprima. It turns out that, on
  // non-Chrome browsers, to check whether a string is in a set, a
  // predicate containing a big ugly `switch` statement is faster than
  // a regular expression, and on Chrome the two are about on par.
  // This function uses `eval` (non-lexical) to produce such a
  // predicate from a space-separated string of words.
  //
  // It starts by sorting the words by length.

  // Removed to create an eval-free library

  // The ECMAScript 3 reserved word list.

  var isReservedWord3 = function anonymous(str) {
switch(str.length){case 6:switch(str){case "double":case "export":case "import":case "native":case "public":case "static":case "throws":return true}return false;case 4:switch(str){case "byte":case "char":case "enum":case "goto":case "long":return true}return false;case 5:switch(str){case "class":case "final":case "float":case "short":case "super":return true}return false;case 7:switch(str){case "boolean":case "extends":case "package":case "private":return true}return false;case 9:switch(str){case "interface":case "protected":case "transient":return true}return false;case 8:switch(str){case "abstract":case "volatile":return true}return false;case 10:return str === "implements";case 3:return str === "int";case 12:return str === "synchronized";}
};

  // ECMAScript 5 reserved words.

  var isReservedWord5 = function anonymous(str) {
switch(str.length){case 5:switch(str){case "class":case "super":case "const":return true}return false;case 6:switch(str){case "export":case "import":return true}return false;case 4:return str === "enum";case 7:return str === "extends";}
};

  // The additional reserved words in strict mode.

  var isStrictReservedWord = function anonymous(str) {
switch(str.length){case 9:switch(str){case "interface":case "protected":return true}return false;case 7:switch(str){case "package":case "private":return true}return false;case 6:switch(str){case "public":case "static":return true}return false;case 10:return str === "implements";case 3:return str === "let";case 5:return str === "yield";}
};

  // The forbidden variable names in strict mode.

  var isStrictBadIdWord = function anonymous(str) {
switch(str){case "eval":case "arguments":return true}return false;
};

  // And the keywords.

  var ecma5AndLessKeywords = "break case catch continue debugger default do else finally for function if return switch throw try var while with null true false instanceof typeof void delete new in this";

  var isEcma5AndLessKeyword = function anonymous(str) {
switch(str.length){case 4:switch(str){case "case":case "else":case "with":case "null":case "true":case "void":case "this":return true}return false;case 5:switch(str){case "break":case "catch":case "throw":case "while":case "false":return true}return false;case 3:switch(str){case "for":case "try":case "var":case "new":return true}return false;case 6:switch(str){case "return":case "switch":case "typeof":case "delete":return true}return false;case 8:switch(str){case "continue":case "debugger":case "function":return true}return false;case 2:switch(str){case "do":case "if":case "in":return true}return false;case 7:switch(str){case "default":case "finally":return true}return false;case 10:return str === "instanceof";}
};

  var ecma6AndLessKeywords = ecma5AndLessKeywords + " let const class extends export import yield";

  var isEcma6Keyword = function anonymous(str) {
switch(str.length){case 5:switch(str){case "break":case "catch":case "throw":case "while":case "false":case "const":case "class":case "yield":return true}return false;case 4:switch(str){case "case":case "else":case "with":case "null":case "true":case "void":case "this":return true}return false;case 6:switch(str){case "return":case "switch":case "typeof":case "delete":case "export":case "import":return true}return false;case 3:switch(str){case "for":case "try":case "var":case "new":case "let":return true}return false;case 8:switch(str){case "continue":case "debugger":case "function":return true}return false;case 7:switch(str){case "default":case "finally":case "extends":return true}return false;case 2:switch(str){case "do":case "if":case "in":return true}return false;case 10:return str === "instanceof";}
};

  var isKeyword = isEcma5AndLessKeyword;

  // ## Character categories

  // Big ugly regular expressions that match characters in the
  // whitespace, identifier, and identifier-start categories. These
  // are only applied when a character is found to actually have a
  // code point above 128.
  // Generated by `tools/generate-identifier-regex.js`.

  var nonASCIIwhitespace = /[\u1680\u180e\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
  var nonASCIIidentifierStartChars = "\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u08A0-\u08B2\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58\u0C59\u0C60\u0C61\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D60\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F4\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19C1-\u19C7\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2119-\u211D\u2124\u2126\u2128\u212A-\u212D\u212F-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2E2F\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312D\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FCC\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA78E\uA790-\uA7AD\uA7B0\uA7B1\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB5F\uAB64\uAB65\uABC0-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC";
  var nonASCIIidentifierChars = "\u0300-\u036F\u0483-\u0487\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u0610-\u061A\u064B-\u0669\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u06F0-\u06F9\u0711\u0730-\u074A\u07A6-\u07B0\u07C0-\u07C9\u07EB-\u07F3\u0816-\u0819\u081B-\u0823\u0825-\u0827\u0829-\u082D\u0859-\u085B\u08E4-\u0903\u093A-\u093C\u093E-\u094F\u0951-\u0957\u0962\u0963\u0966-\u096F\u0981-\u0983\u09BC\u09BE-\u09C4\u09C7\u09C8\u09CB-\u09CD\u09D7\u09E2\u09E3\u09E6-\u09EF\u0A01-\u0A03\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A66-\u0A71\u0A75\u0A81-\u0A83\u0ABC\u0ABE-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AE2\u0AE3\u0AE6-\u0AEF\u0B01-\u0B03\u0B3C\u0B3E-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B62\u0B63\u0B66-\u0B6F\u0B82\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD7\u0BE6-\u0BEF\u0C00-\u0C03\u0C3E-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C62\u0C63\u0C66-\u0C6F\u0C81-\u0C83\u0CBC\u0CBE-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CE2\u0CE3\u0CE6-\u0CEF\u0D01-\u0D03\u0D3E-\u0D44\u0D46-\u0D48\u0D4A-\u0D4D\u0D57\u0D62\u0D63\u0D66-\u0D6F\u0D82\u0D83\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0E50-\u0E59\u0EB1\u0EB4-\u0EB9\u0EBB\u0EBC\u0EC8-\u0ECD\u0ED0-\u0ED9\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E\u0F3F\u0F71-\u0F84\u0F86\u0F87\u0F8D-\u0F97\u0F99-\u0FBC\u0FC6\u102B-\u103E\u1040-\u1049\u1056-\u1059\u105E-\u1060\u1062-\u1064\u1067-\u106D\u1071-\u1074\u1082-\u108D\u108F-\u109D\u135D-\u135F\u1712-\u1714\u1732-\u1734\u1752\u1753\u1772\u1773\u17B4-\u17D3\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u18A9\u1920-\u192B\u1930-\u193B\u1946-\u194F\u19B0-\u19C0\u19C8\u19C9\u19D0-\u19D9\u1A17-\u1A1B\u1A55-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AB0-\u1ABD\u1B00-\u1B04\u1B34-\u1B44\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1B82\u1BA1-\u1BAD\u1BB0-\u1BB9\u1BE6-\u1BF3\u1C24-\u1C37\u1C40-\u1C49\u1C50-\u1C59\u1CD0-\u1CD2\u1CD4-\u1CE8\u1CED\u1CF2-\u1CF4\u1CF8\u1CF9\u1DC0-\u1DF5\u1DFC-\u1DFF\u200C\u200D\u203F\u2040\u2054\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302F\u3099\u309A\uA620-\uA629\uA66F\uA674-\uA67D\uA69F\uA6F0\uA6F1\uA802\uA806\uA80B\uA823-\uA827\uA880\uA881\uA8B4-\uA8C4\uA8D0-\uA8D9\uA8E0-\uA8F1\uA900-\uA909\uA926-\uA92D\uA947-\uA953\uA980-\uA983\uA9B3-\uA9C0\uA9D0-\uA9D9\uA9E5\uA9F0-\uA9F9\uAA29-\uAA36\uAA43\uAA4C\uAA4D\uAA50-\uAA59\uAA7B-\uAA7D\uAAB0\uAAB2-\uAAB4\uAAB7\uAAB8\uAABE\uAABF\uAAC1\uAAEB-\uAAEF\uAAF5\uAAF6\uABE3-\uABEA\uABEC\uABED\uABF0-\uABF9\uFB1E\uFE00-\uFE0F\uFE20-\uFE2D\uFE33\uFE34\uFE4D-\uFE4F\uFF10-\uFF19\uFF3F";
  var nonASCIIidentifierStart = new RegExp("[" + nonASCIIidentifierStartChars + "]");
  var nonASCIIidentifier = new RegExp("[" + nonASCIIidentifierStartChars + nonASCIIidentifierChars + "]");

  var decimalNumber = /^\d+$/;
  var hexNumber = /^[\da-fA-F]+$/;

  // Whether a single character denotes a newline.

  var newline = /[\n\r\u2028\u2029]/;

  function isNewLine(code) {
    return code === 10 || code === 13 || code === 0x2028 || code == 0x2029;
  }

  // Matches a whole line break (where CRLF is considered a single
  // line break). Used to count lines.

  var lineBreak = /\r\n|[\n\r\u2028\u2029]/g;

  // Test whether a given character code starts an identifier.

  var isIdentifierStart = exports.isIdentifierStart = function(code) {
    if (code < 65) return code === 36;
    if (code < 91) return true;
    if (code < 97) return code === 95;
    if (code < 123)return true;
    return code >= 0xaa && nonASCIIidentifierStart.test(String.fromCharCode(code));
  };

  // Test whether a given character is part of an identifier.

  var isIdentifierChar = exports.isIdentifierChar = function(code) {
    if (code < 48) return code === 36;
    if (code < 58) return true;
    if (code < 65) return false;
    if (code < 91) return true;
    if (code < 97) return code === 95;
    if (code < 123)return true;
    return code >= 0xaa && nonASCIIidentifier.test(String.fromCharCode(code));
  };

  // ## Tokenizer

  // These are used when `options.locations` is on, for the
  // `tokStartLoc` and `tokEndLoc` properties.

  function Position(line, col) {
    this.line = line;
    this.column = col;
  }

  Position.prototype.offset = function(n) {
    return new Position(this.line, this.column + n);
  }

  function curPosition() {
    return new Position(tokCurLine, tokPos - tokLineStart);
  }

  // Reset the token state. Used at the start of a parse.

  function initTokenState(pos) {
    if (pos) {
      tokPos = pos;
      tokLineStart = Math.max(0, input.lastIndexOf("\n", pos));
      tokCurLine = input.slice(0, tokLineStart).split(newline).length;
    } else {
      tokCurLine = 1;
      tokPos = tokLineStart = 0;
    }
    tokRegexpAllowed = true;
    metParenL = 0;
    inType = inXJSChild = inXJSTag = false;
    templates = [];
    if (tokPos === 0 && options.allowHashBang && input.slice(0, 2) === '#!') {
      skipLineComment(2);
    }
  }

  // Called at the end of every token. Sets `tokEnd`, `tokVal`, and
  // `tokRegexpAllowed`, and skips the space after the token, so that
  // the next one's `tokStart` will point at the right position.

  function finishToken(type, val, shouldSkipSpace) {
    tokEnd = tokPos;
    if (options.locations) tokEndLoc = curPosition();
    tokType = type;
    if (shouldSkipSpace !== false) skipSpace();
    tokVal = val;
    tokRegexpAllowed = type.beforeExpr;
    if (options.onToken) {
      options.onToken(new Token());
    }
  }

  function skipBlockComment() {
    var startLoc = options.onComment && options.locations && curPosition();
    var start = tokPos, end = input.indexOf("*/", tokPos += 2);
    if (end === -1) raise(tokPos - 2, "Unterminated comment");
    tokPos = end + 2;
    if (options.locations) {
      lineBreak.lastIndex = start;
      var match;
      while ((match = lineBreak.exec(input)) && match.index < tokPos) {
        ++tokCurLine;
        tokLineStart = match.index + match[0].length;
      }
    }
    if (options.onComment)
      options.onComment(true, input.slice(start + 2, end), start, tokPos,
                        startLoc, options.locations && curPosition());
  }

  function skipLineComment(startSkip) {
    var start = tokPos;
    var startLoc = options.onComment && options.locations && curPosition();
    var ch = input.charCodeAt(tokPos+=startSkip);
    while (tokPos < inputLen && ch !== 10 && ch !== 13 && ch !== 8232 && ch !== 8233) {
      ++tokPos;
      ch = input.charCodeAt(tokPos);
    }
    if (options.onComment)
      options.onComment(false, input.slice(start + startSkip, tokPos), start, tokPos,
                        startLoc, options.locations && curPosition());
  }

  // Called at the start of the parse and after every token. Skips
  // whitespace and comments, and.

  function skipSpace() {
    while (tokPos < inputLen) {
      var ch = input.charCodeAt(tokPos);
      if (ch === 32) { // ' '
        ++tokPos;
      } else if (ch === 13) {
        ++tokPos;
        var next = input.charCodeAt(tokPos);
        if (next === 10) {
          ++tokPos;
        }
        if (options.locations) {
          ++tokCurLine;
          tokLineStart = tokPos;
        }
      } else if (ch === 10 || ch === 8232 || ch === 8233) {
        ++tokPos;
        if (options.locations) {
          ++tokCurLine;
          tokLineStart = tokPos;
        }
      } else if (ch > 8 && ch < 14) {
        ++tokPos;
      } else if (ch === 47) { // '/'
        var next = input.charCodeAt(tokPos + 1);
        if (next === 42) { // '*'
          skipBlockComment();
        } else if (next === 47) { // '/'
          skipLineComment(2);
        } else break;
      } else if (ch === 160) { // '\xa0'
        ++tokPos;
      } else if (ch >= 5760 && nonASCIIwhitespace.test(String.fromCharCode(ch))) {
        ++tokPos;
      } else {
        break;
      }
    }
  }

  // ### Token reading

  // This is the function that is called to fetch the next token. It
  // is somewhat obscure, because it works in character codes rather
  // than characters, and because operator parsing has been inlined
  // into it.
  //
  // All in the name of speed.
  //
  // The `forceRegexp` parameter is used in the one case where the
  // `tokRegexpAllowed` trick does not work. See `parseStatement`.

  function readToken_dot() {
    var next = input.charCodeAt(tokPos + 1);
    if (next >= 48 && next <= 57) return readNumber(true);
    var next2 = input.charCodeAt(tokPos + 2);
    if (options.playground && next === 63) { // 63
      tokPos += 2;
      return finishToken(_dotQuestion);
    } else if (options.ecmaVersion >= 6 && next === 46 && next2 === 46) { // 46 = dot '.'
      tokPos += 3;
      return finishToken(_ellipsis);
    } else {
      ++tokPos;
      return finishToken(_dot);
    }
  }

  function readToken_slash() { // '/'
    var next = input.charCodeAt(tokPos + 1);
    if (tokRegexpAllowed) {++tokPos; return readRegexp();}
    if (next === 61) return finishOp(_assign, 2);
    return finishOp(_slash, 1);
  }

  function readToken_modulo() { // '%'
    var next = input.charCodeAt(tokPos + 1);
    if (next === 61) return finishOp(_assign, 2);
    return finishOp(_modulo, 1);
  }

  function readToken_mult() { // '*'
    var type = _star;
    var width = 1;
    var next = input.charCodeAt(tokPos + 1);

    if (options.ecmaVersion >= 7 && next === 42) { // '*'
      width++;
      next = input.charCodeAt(tokPos + 2);
      type = _exponent;
    }

    if (next === 61) { // '='
      width++;
      type = _assign;
    }
    
    return finishOp(type, width);
  }

  function readToken_pipe_amp(code) { // '|&'
    var next = input.charCodeAt(tokPos + 1);
    if (next === code) return finishOp(code === 124 ? _logicalOR : _logicalAND, 2);
    if (next === 61) return finishOp(_assign, 2);
    return finishOp(code === 124 ? _bitwiseOR : _bitwiseAND, 1);
  }

  function readToken_caret() { // '^'
    var next = input.charCodeAt(tokPos + 1);
    if (next === 61) return finishOp(_assign, 2);
    return finishOp(_bitwiseXOR, 1);
  }

  function readToken_plus_min(code) { // '+-'
    var next = input.charCodeAt(tokPos + 1);
    if (next === code) {
      if (next == 45 && input.charCodeAt(tokPos + 2) == 62 &&
          newline.test(input.slice(lastEnd, tokPos))) {
        // A `-->` line comment
        skipLineComment(3);
        skipSpace();
        return readToken();
      }
      return finishOp(_incDec, 2);
    }
    if (next === 61) return finishOp(_assign, 2);
    return finishOp(_plusMin, 1);
  }

  function readToken_lt_gt(code) { // '<>'
    var next = input.charCodeAt(tokPos + 1);
    var size = 1;
    if (!inType && next === code) {
      size = code === 62 && input.charCodeAt(tokPos + 2) === 62 ? 3 : 2;
      if (input.charCodeAt(tokPos + size) === 61) return finishOp(_assign, size + 1);
      return finishOp(_bitShift, size);
    }
    if (next == 33 && code == 60 && input.charCodeAt(tokPos + 2) == 45 &&
        input.charCodeAt(tokPos + 3) == 45) {
      // `<!--`, an XML-style comment that should be interpreted as a line comment
      skipLineComment(4);
      skipSpace();
      return readToken();
    }
    if (next === 61) {
      size = input.charCodeAt(tokPos + 2) === 61 ? 3 : 2;
      return finishOp(_relational, size);
    }
    if (code === 60 && next === 47) {
      // '</', beginning of JSX closing element
      size = 2;
      return finishOp(_ltSlash, size);
    }
    return code === 60 ? finishOp(_lt, size) : finishOp(_gt, size, !inXJSTag);
  }

  function readToken_eq_excl(code) { // '=!', '=>'
    var next = input.charCodeAt(tokPos + 1);
    if (next === 61) return finishOp(_equality, input.charCodeAt(tokPos + 2) === 61 ? 3 : 2);
    if (code === 61 && next === 62 && options.ecmaVersion >= 6) { // '=>'
      tokPos += 2;
      return finishToken(_arrow);
    }
    return finishOp(code === 61 ? _eq : _prefix, 1);
  }

  // Get token inside ES6 template (special rules work there).

  function getTemplateToken(code) {
    // '`' and '${' have special meanings, but they should follow
    // string (can be empty)
    if (tokType === _string) {
      if (code === 96) { // '`'
        ++tokPos;
        return finishToken(_bquote);
      } else if (code === 36 && input.charCodeAt(tokPos + 1) === 123) { // '${'
        tokPos += 2;
        return finishToken(_dollarBraceL);
      }
    }
    // anything else is considered string literal
    return readTmplString();
  }

  function getTokenFromCode(code) {
    switch(code) {
      // The interpretation of a dot depends on whether it is followed
      // by a digit or another two dots.
    case 46: // '.'
      return readToken_dot();

      // Punctuation tokens.
    case 40: ++tokPos; return finishToken(_parenL);
    case 41: ++tokPos; return finishToken(_parenR);
    case 59: ++tokPos; return finishToken(_semi);
    case 44: ++tokPos; return finishToken(_comma);
    case 91: ++tokPos; return finishToken(_bracketL);
    case 93: ++tokPos; return finishToken(_bracketR);
    case 123:
      ++tokPos;
      if (templates.length) ++templates[templates.length - 1];
      return finishToken(_braceL);
    case 125:
      ++tokPos;
      if (templates.length && --templates[templates.length - 1] === 0)
        return readTemplateString(_templateContinued);
      else
        return finishToken(_braceR);
    case 63: ++tokPos; return finishToken(_question);

    case 64:
      if (options.playground) {
        ++tokPos;
        return finishToken(_at);
      }

    case 35:
      if (options.playground) {
        ++tokPos;
        return finishToken(_hash);
      }

    case 58:
      ++tokPos;
      if (options.ecmaVersion >= 7) {
        var next = input.charCodeAt(tokPos);
        if (next === 58) {
          ++tokPos;
          return finishToken(_paamayimNekudotayim);
        }
      }
      return finishToken(_colon);

    case 96: // '`'
      if (options.ecmaVersion >= 6) {
        ++tokPos;
        return readTemplateString(_template);
      }

    case 48: // '0'
      var next = input.charCodeAt(tokPos + 1);
      if (next === 120 || next === 88) return readRadixNumber(16); // '0x', '0X' - hex number
      if (options.ecmaVersion >= 6) {
        if (next === 111 || next === 79) return readRadixNumber(8); // '0o', '0O' - octal number
        if (next === 98 || next === 66) return readRadixNumber(2); // '0b', '0B' - binary number
      }
      // Anything else beginning with a digit is an integer, octal
      // number, or float.
    case 49: case 50: case 51: case 52: case 53: case 54: case 55: case 56: case 57: // 1-9
      return readNumber(false);

      // Quotes produce strings.
    case 34: case 39: // '"', "'"
      return inXJSTag ? readXJSStringLiteral() : readString(code);

    // Operators are parsed inline in tiny state machines. '=' (61) is
    // often referred to. `finishOp` simply skips the amount of
    // characters it is given as second argument, and returns a token
    // of the type given by its first argument.

    case 47: // '/'
      return readToken_slash();

    case 37: // '%'
      return readToken_modulo();

    case 42: // '*'
      return readToken_mult();

    case 124: case 38: // '|&'
      return readToken_pipe_amp(code);

    case 94: // '^'
      return readToken_caret();

    case 43: case 45: // '+-'
      return readToken_plus_min(code);

    case 60: case 62: // '<>'
      return readToken_lt_gt(code);

    case 61: case 33: // '=!'
      return readToken_eq_excl(code);

    case 126: // '~'
      return finishOp(_prefix, 1);
    }

    return false;
  }

  function readToken(forceRegexp) {
    if (!forceRegexp) tokStart = tokPos;
    else tokPos = tokStart + 1;
    if (options.locations) tokStartLoc = curPosition();
    if (forceRegexp) return readRegexp();
    if (tokPos >= inputLen) return finishToken(_eof);

    var code = input.charCodeAt(tokPos);

    // JSX content - either simple text, start of <tag> or {expression}
    if (inXJSChild && tokType !== _braceL && code !== 60 && code !== 123 && code !== 125) {
      return readXJSText(['<', '{']);
    }

    // Identifier or keyword. '\uXXXX' sequences are allowed in
    // identifiers, so '\' also dispatches to that.
    if (isIdentifierStart(code) || code === 92 /* '\' */) return readWord();

    var tok = getTokenFromCode(code);

    if (tok === false) {
      // If we are here, we either found a non-ASCII identifier
      // character, or something that's entirely disallowed.
      var ch = String.fromCharCode(code);
      if (ch === "\\" || nonASCIIidentifierStart.test(ch)) return readWord();
      raise(tokPos, "Unexpected character '" + ch + "'");
    }
    return tok;
  }

  function finishOp(type, size, shouldSkipSpace) {
    var str = input.slice(tokPos, tokPos + size);
    tokPos += size;
    finishToken(type, str, shouldSkipSpace);
  }

  var regexpUnicodeSupport = false;
  try { new RegExp("\uffff", "u"); regexpUnicodeSupport = true; }
  catch(e) {}

  // Parse a regular expression. Some context-awareness is necessary,
  // since a '/' inside a '[]' set does not end the expression.

  function readRegexp() {
    var content = "", escaped, inClass, start = tokPos;
    for (;;) {
      if (tokPos >= inputLen) raise(start, "Unterminated regular expression");
      var ch = nextChar();
      if (newline.test(ch)) raise(start, "Unterminated regular expression");
      if (!escaped) {
        if (ch === "[") inClass = true;
        else if (ch === "]" && inClass) inClass = false;
        else if (ch === "/" && !inClass) break;
        escaped = ch === "\\";
      } else escaped = false;
      ++tokPos;
    }
    var content = input.slice(start, tokPos);
    ++tokPos;
    // Need to use `readWord1` because '\uXXXX' sequences are allowed
    // here (don't ask).
    var mods = readWord1();
    // Detect invalid regular expressions.
    var tmp = content;
    if (mods) {
      var validFlags = /^[gmsiy]*$/;
      if (options.ecmaVersion >= 6) validFlags = /^[gmsiyu]*$/;
      if (!validFlags.test(mods)) raise(start, "Invalid regular expression flag");
      if (mods.indexOf('u') >= 0 && !regexpUnicodeSupport) {
        // Replace each astral symbol and every Unicode code point
        // escape sequence that represents such a symbol with a single
        // ASCII symbol to avoid throwing on regular expressions that
        // are only valid in combination with the `/u` flag.
        tmp = tmp
          .replace(/\\u\{([0-9a-fA-F]{5,6})\}/g, "x")
          .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "x");
      }
    }
    // Detect invalid regular expressions.
    try {
      new RegExp(tmp);
    } catch (e) {
      if (e instanceof SyntaxError) raise(start, "Error parsing regular expression: " + e.message);
      raise(e);
    }
    // Get a regular expression object for this pattern-flag pair, or `null` in
    // case the current environment doesn't support the flags it uses.
    try {
      var value = new RegExp(content, mods);
    } catch (err) {
      value = null;
  }
    return finishToken(_regexp, {pattern: content, flags: mods, value: value});
  }

  // Read an integer in the given radix. Return null if zero digits
  // were read, the integer value otherwise. When `len` is given, this
  // will return `null` unless the integer has exactly `len` digits.

  function readInt(radix, len) {
    var start = tokPos, total = 0;
    for (var i = 0, e = len == null ? Infinity : len; i < e; ++i) {
      var code = input.charCodeAt(tokPos), val;
      if (code >= 97) val = code - 97 + 10; // a
      else if (code >= 65) val = code - 65 + 10; // A
      else if (code >= 48 && code <= 57) val = code - 48; // 0-9
      else val = Infinity;
      if (val >= radix) break;
      ++tokPos;
      total = total * radix + val;
    }
    if (tokPos === start || len != null && tokPos - start !== len) return null;

    return total;
  }

  function readRadixNumber(radix) {
    tokPos += 2; // 0x
    var val = readInt(radix);
    if (val == null) raise(tokStart + 2, "Expected number in radix " + radix);
    if (isIdentifierStart(input.charCodeAt(tokPos))) raise(tokPos, "Identifier directly after number");
    return finishToken(_num, val);
  }

  // Read an integer, octal integer, or floating-point number.

  function readNumber(startsWithDot) {
    var start = tokPos, isFloat = false, octal = input.charCodeAt(tokPos) === 48;
    if (!startsWithDot && readInt(10) === null) raise(start, "Invalid number");
    if (input.charCodeAt(tokPos) === 46) {
      ++tokPos;
      readInt(10);
      isFloat = true;
    }
    var next = input.charCodeAt(tokPos);
    if (next === 69 || next === 101) { // 'eE'
      next = input.charCodeAt(++tokPos);
      if (next === 43 || next === 45) ++tokPos; // '+-'
      if (readInt(10) === null) raise(start, "Invalid number");
      isFloat = true;
    }
    if (isIdentifierStart(input.charCodeAt(tokPos))) raise(tokPos, "Identifier directly after number");

    var str = input.slice(start, tokPos), val;
    if (isFloat) val = parseFloat(str);
    else if (!octal || str.length === 1) val = parseInt(str, 10);
    else if (/[89]/.test(str) || strict) raise(start, "Invalid number");
    else val = parseInt(str, 8);
    return finishToken(_num, val);
  }

  // Read a string value, interpreting backslash-escapes.

  function readCodePoint() {
    var ch = input.charCodeAt(tokPos), code;
    
    if (ch === 123) {
      if (options.ecmaVersion < 6) unexpected();
      ++tokPos;
      code = readHexChar(input.indexOf('}', tokPos) - tokPos);
      ++tokPos;
      if (code > 0x10FFFF) unexpected();
    } else {
      code = readHexChar(4);
    }

    // UTF-16 Encoding
    if (code <= 0xFFFF) {
      return String.fromCharCode(code);
    }
    var cu1 = ((code - 0x10000) >> 10) + 0xD800;
    var cu2 = ((code - 0x10000) & 1023) + 0xDC00;
    return String.fromCharCode(cu1, cu2);
  }

  function readString(quote) {
    ++tokPos;
    var out = "";
    for (;;) {
      if (tokPos >= inputLen) raise(tokStart, "Unterminated string constant");
      var ch = input.charCodeAt(tokPos);
      if (ch === quote) {
        ++tokPos;
        return finishToken(_string, out);
      }
      if (ch === 92) { // '\'
        out += readEscapedChar();
      } else {
        ++tokPos;
        if (newline.test(String.fromCharCode(ch))) {
          raise(tokStart, "Unterminated string constant");
          }
        out += String.fromCharCode(ch); // '\'
        }
    }
  }

  function readTemplateString(type) {
    if (type == _templateContinued) templates.pop();
    var out = "", start = tokPos;;
    for (;;) {
      if (tokPos >= inputLen) raise(tokStart, "Unterminated template");
      var ch = input.charAt(tokPos);
      if (ch === "`" || ch === "$" && input.charCodeAt(tokPos + 1) === 123) { // '`', '${'
        var raw = input.slice(start, tokPos);
        ++tokPos;
        if (ch == "$") { ++tokPos; templates.push(1); }
        return finishToken(type, {cooked: out, raw: raw});
      }

      if (ch === "\\") { // '\'
        out += readEscapedChar();
      } else {
        ++tokPos;
        if (newline.test(ch)) {
          if (ch === "\r" && input.charCodeAt(tokPos) === 10) {
            ++tokPos;
            ch = "\n";
          }
          if (options.locations) {
            ++tokCurLine;
            tokLineStart = tokPos;
          }
        }
        out += ch;
      }
    }
  }

  // Used to read escaped characters

  function readEscapedChar() {
    var ch = input.charCodeAt(++tokPos);
    var octal = /^[0-7]+/.exec(input.slice(tokPos, tokPos + 3));
    if (octal) octal = octal[0];
    while (octal && parseInt(octal, 8) > 255) octal = octal.slice(0, -1);
    if (octal === "0") octal = null;
    ++tokPos;
    if (octal) {
      if (strict) raise(tokPos - 2, "Octal literal in strict mode");
      tokPos += octal.length - 1;
      return String.fromCharCode(parseInt(octal, 8));
    } else {
      switch (ch) {
        case 110: return "\n"; // 'n' -> '\n'
        case 114: return "\r"; // 'r' -> '\r'
        case 120: return String.fromCharCode(readHexChar(2)); // 'x'
        case 117: return readCodePoint(); // 'u'
        case 116: return "\t"; // 't' -> '\t'
        case 98: return "\b"; // 'b' -> '\b'
        case 118: return "\u000b"; // 'v' -> '\u000b'
        case 102: return "\f"; // 'f' -> '\f'
        case 48: return "\0"; // 0 -> '\0'
        case 13: if (input.charCodeAt(tokPos) === 10) ++tokPos; // '\r\n'
        case 10: // ' \n'
          if (options.locations) { tokLineStart = tokPos; ++tokCurLine; }
          return "";
        default: return String.fromCharCode(ch);
      }
    }
  }

  var XHTMLEntities = {
    quot: '\u0022',
    amp: '&',
    apos: '\u0027',
    lt: '<',
    gt: '>',
    nbsp: '\u00A0',
    iexcl: '\u00A1',
    cent: '\u00A2',
    pound: '\u00A3',
    curren: '\u00A4',
    yen: '\u00A5',
    brvbar: '\u00A6',
    sect: '\u00A7',
    uml: '\u00A8',
    copy: '\u00A9',
    ordf: '\u00AA',
    laquo: '\u00AB',
    not: '\u00AC',
    shy: '\u00AD',
    reg: '\u00AE',
    macr: '\u00AF',
    deg: '\u00B0',
    plusmn: '\u00B1',
    sup2: '\u00B2',
    sup3: '\u00B3',
    acute: '\u00B4',
    micro: '\u00B5',
    para: '\u00B6',
    middot: '\u00B7',
    cedil: '\u00B8',
    sup1: '\u00B9',
    ordm: '\u00BA',
    raquo: '\u00BB',
    frac14: '\u00BC',
    frac12: '\u00BD',
    frac34: '\u00BE',
    iquest: '\u00BF',
    Agrave: '\u00C0',
    Aacute: '\u00C1',
    Acirc: '\u00C2',
    Atilde: '\u00C3',
    Auml: '\u00C4',
    Aring: '\u00C5',
    AElig: '\u00C6',
    Ccedil: '\u00C7',
    Egrave: '\u00C8',
    Eacute: '\u00C9',
    Ecirc: '\u00CA',
    Euml: '\u00CB',
    Igrave: '\u00CC',
    Iacute: '\u00CD',
    Icirc: '\u00CE',
    Iuml: '\u00CF',
    ETH: '\u00D0',
    Ntilde: '\u00D1',
    Ograve: '\u00D2',
    Oacute: '\u00D3',
    Ocirc: '\u00D4',
    Otilde: '\u00D5',
    Ouml: '\u00D6',
    times: '\u00D7',
    Oslash: '\u00D8',
    Ugrave: '\u00D9',
    Uacute: '\u00DA',
    Ucirc: '\u00DB',
    Uuml: '\u00DC',
    Yacute: '\u00DD',
    THORN: '\u00DE',
    szlig: '\u00DF',
    agrave: '\u00E0',
    aacute: '\u00E1',
    acirc: '\u00E2',
    atilde: '\u00E3',
    auml: '\u00E4',
    aring: '\u00E5',
    aelig: '\u00E6',
    ccedil: '\u00E7',
    egrave: '\u00E8',
    eacute: '\u00E9',
    ecirc: '\u00EA',
    euml: '\u00EB',
    igrave: '\u00EC',
    iacute: '\u00ED',
    icirc: '\u00EE',
    iuml: '\u00EF',
    eth: '\u00F0',
    ntilde: '\u00F1',
    ograve: '\u00F2',
    oacute: '\u00F3',
    ocirc: '\u00F4',
    otilde: '\u00F5',
    ouml: '\u00F6',
    divide: '\u00F7',
    oslash: '\u00F8',
    ugrave: '\u00F9',
    uacute: '\u00FA',
    ucirc: '\u00FB',
    uuml: '\u00FC',
    yacute: '\u00FD',
    thorn: '\u00FE',
    yuml: '\u00FF',
    OElig: '\u0152',
    oelig: '\u0153',
    Scaron: '\u0160',
    scaron: '\u0161',
    Yuml: '\u0178',
    fnof: '\u0192',
    circ: '\u02C6',
    tilde: '\u02DC',
    Alpha: '\u0391',
    Beta: '\u0392',
    Gamma: '\u0393',
    Delta: '\u0394',
    Epsilon: '\u0395',
    Zeta: '\u0396',
    Eta: '\u0397',
    Theta: '\u0398',
    Iota: '\u0399',
    Kappa: '\u039A',
    Lambda: '\u039B',
    Mu: '\u039C',
    Nu: '\u039D',
    Xi: '\u039E',
    Omicron: '\u039F',
    Pi: '\u03A0',
    Rho: '\u03A1',
    Sigma: '\u03A3',
    Tau: '\u03A4',
    Upsilon: '\u03A5',
    Phi: '\u03A6',
    Chi: '\u03A7',
    Psi: '\u03A8',
    Omega: '\u03A9',
    alpha: '\u03B1',
    beta: '\u03B2',
    gamma: '\u03B3',
    delta: '\u03B4',
    epsilon: '\u03B5',
    zeta: '\u03B6',
    eta: '\u03B7',
    theta: '\u03B8',
    iota: '\u03B9',
    kappa: '\u03BA',
    lambda: '\u03BB',
    mu: '\u03BC',
    nu: '\u03BD',
    xi: '\u03BE',
    omicron: '\u03BF',
    pi: '\u03C0',
    rho: '\u03C1',
    sigmaf: '\u03C2',
    sigma: '\u03C3',
    tau: '\u03C4',
    upsilon: '\u03C5',
    phi: '\u03C6',
    chi: '\u03C7',
    psi: '\u03C8',
    omega: '\u03C9',
    thetasym: '\u03D1',
    upsih: '\u03D2',
    piv: '\u03D6',
    ensp: '\u2002',
    emsp: '\u2003',
    thinsp: '\u2009',
    zwnj: '\u200C',
    zwj: '\u200D',
    lrm: '\u200E',
    rlm: '\u200F',
    ndash: '\u2013',
    mdash: '\u2014',
    lsquo: '\u2018',
    rsquo: '\u2019',
    sbquo: '\u201A',
    ldquo: '\u201C',
    rdquo: '\u201D',
    bdquo: '\u201E',
    dagger: '\u2020',
    Dagger: '\u2021',
    bull: '\u2022',
    hellip: '\u2026',
    permil: '\u2030',
    prime: '\u2032',
    Prime: '\u2033',
    lsaquo: '\u2039',
    rsaquo: '\u203A',
    oline: '\u203E',
    frasl: '\u2044',
    euro: '\u20AC',
    image: '\u2111',
    weierp: '\u2118',
    real: '\u211C',
    trade: '\u2122',
    alefsym: '\u2135',
    larr: '\u2190',
    uarr: '\u2191',
    rarr: '\u2192',
    darr: '\u2193',
    harr: '\u2194',
    crarr: '\u21B5',
    lArr: '\u21D0',
    uArr: '\u21D1',
    rArr: '\u21D2',
    dArr: '\u21D3',
    hArr: '\u21D4',
    forall: '\u2200',
    part: '\u2202',
    exist: '\u2203',
    empty: '\u2205',
    nabla: '\u2207',
    isin: '\u2208',
    notin: '\u2209',
    ni: '\u220B',
    prod: '\u220F',
    sum: '\u2211',
    minus: '\u2212',
    lowast: '\u2217',
    radic: '\u221A',
    prop: '\u221D',
    infin: '\u221E',
    ang: '\u2220',
    and: '\u2227',
    or: '\u2228',
    cap: '\u2229',
    cup: '\u222A',
    'int': '\u222B',
    there4: '\u2234',
    sim: '\u223C',
    cong: '\u2245',
    asymp: '\u2248',
    ne: '\u2260',
    equiv: '\u2261',
    le: '\u2264',
    ge: '\u2265',
    sub: '\u2282',
    sup: '\u2283',
    nsub: '\u2284',
    sube: '\u2286',
    supe: '\u2287',
    oplus: '\u2295',
    otimes: '\u2297',
    perp: '\u22A5',
    sdot: '\u22C5',
    lceil: '\u2308',
    rceil: '\u2309',
    lfloor: '\u230A',
    rfloor: '\u230B',
    lang: '\u2329',
    rang: '\u232A',
    loz: '\u25CA',
    spades: '\u2660',
    clubs: '\u2663',
    hearts: '\u2665',
    diams: '\u2666'
  };

  function readXJSEntity() {
    var str = '', count = 0, entity;
    var ch = nextChar();
    if (ch !== '&') raise(tokPos, "Entity must start with an ampersand");
    var startPos = ++tokPos;
    while (tokPos < inputLen && count++ < 10) {
      ch = nextChar();
      tokPos++;
      if (ch === ';') {
        if (str[0] === '#') {
          if (str[1] === 'x') {
            str = str.substr(2);
            if (hexNumber.test(str)) {
              entity = String.fromCharCode(parseInt(str, 16));
            }
          } else {
            str = str.substr(1);
            if (decimalNumber.test(str)) {
              entity = String.fromCharCode(parseInt(str, 10));
            }
          }
        } else {
          entity = XHTMLEntities[str];
        }
        break;
      }
      str += ch;
    }
    if (!entity) {
      tokPos = startPos;
      return '&';
    }
    return entity;
  }

  function readXJSText(stopChars) {
    var str = '';
    while (tokPos < inputLen) {
      var ch = nextChar();
      if (stopChars.indexOf(ch) !== -1) {
        break;
      }
      if (ch === '&') {
        str += readXJSEntity();
      } else {
        ++tokPos;
        if (ch === '\r' && nextChar() === '\n') {
          str += ch;
          ++tokPos;
          ch = '\n';
        }
        if (ch === '\n' && options.locations) {
          tokLineStart = tokPos;
          ++tokCurLine;
        }
        str += ch;
      }
    }
    return finishToken(_xjsText, str);
  }

  function readXJSStringLiteral() {
    var quote = input.charCodeAt(tokPos);

    if (quote !== 34 && quote !== 39) {
      raise("String literal must starts with a quote");
    }

    ++tokPos;

    readXJSText([String.fromCharCode(quote)]);

    if (quote !== input.charCodeAt(tokPos)) {
      unexpected();
    }

    ++tokPos;

    return finishToken(tokType, tokVal);
  }

  // Used to read character escape sequences ('\x', '\u', '\U').

  function readHexChar(len) {
    var n = readInt(16, len);
    if (n === null) raise(tokStart, "Bad character escape sequence");
    return n;
  }

  // Used to signal to callers of `readWord1` whether the word
  // contained any escape sequences. This is needed because words with
  // escape sequences must not be interpreted as keywords.

  var containsEsc;

  // Read an identifier, and return it as a string. Sets `containsEsc`
  // to whether the word contained a '\u' escape.
  //
  // Only builds up the word character-by-character when it actually
  // containeds an escape, as a micro-optimization.

  function readWord1() {
    containsEsc = false;
    var word, first = true, start = tokPos;
    for (;;) {
      var ch = input.charCodeAt(tokPos);
      if (isIdentifierChar(ch) || (inXJSTag && ch === 45)) {
        if (containsEsc) word += nextChar();
        ++tokPos;
      } else if (ch === 92 && !inXJSTag) { // "\"
        if (!containsEsc) word = input.slice(start, tokPos);
        containsEsc = true;
        if (input.charCodeAt(++tokPos) != 117) // "u"
          raise(tokPos, "Expecting Unicode escape sequence \\uXXXX");
        ++tokPos;
        var esc = readHexChar(4);
        var escStr = String.fromCharCode(esc);
        if (!escStr) raise(tokPos - 1, "Invalid Unicode escape");
        if (!(first ? isIdentifierStart(esc) : isIdentifierChar(esc)))
          raise(tokPos - 4, "Invalid Unicode escape");
        word += escStr;
      } else {
        break;
      }
      first = false;
    }
    return containsEsc ? word : input.slice(start, tokPos);
  }

  // Read an identifier or keyword token. Will check for reserved
  // words when necessary.

  function readWord() {
    var word = readWord1();
    var type = inXJSTag ? _xjsName : _name;
    if (!containsEsc && isKeyword(word))
      type = keywordTypes[word];
    return finishToken(type, word);
  }

  // ## Parser

  // A recursive descent parser operates by defining functions for all
  // syntactic elements, and recursively calling those, each function
  // advancing the input stream and returning an AST node. Precedence
  // of constructs (for example, the fact that `!x[1]` means `!(x[1])`
  // instead of `(!x)[1]` is handled by the fact that the parser
  // function that parses unary prefix operators is called first, and
  // in turn calls the function that parses `[]` subscripts — that
  // way, it'll receive the node for `x[1]` already parsed, and wraps
  // *that* in the unary operator node.
  //
  // Acorn uses an [operator precedence parser][opp] to handle binary
  // operator precedence, because it is much more compact than using
  // the technique outlined above, which uses different, nesting
  // functions to specify precedence, for all of the ten binary
  // precedence levels that JavaScript defines.
  //
  // [opp]: http://en.wikipedia.org/wiki/Operator-precedence_parser

  // ### Parser utilities

  // Continue to the next token.

  function next() {
    lastStart = tokStart;
    lastEnd = tokEnd;
    lastEndLoc = tokEndLoc;
    readToken();
  }

  // Enter strict mode. Re-reads the next token to please pedantic
  // tests ("use strict"; 010; -- should fail).

  function setStrict(strct) {
    strict = strct;
    tokPos = tokStart;
    if (options.locations) {
      while (tokPos < tokLineStart) {
        tokLineStart = input.lastIndexOf("\n", tokLineStart - 2) + 1;
        --tokCurLine;
      }
    }
    skipSpace();
    readToken();
  }

  // Start an AST node, attaching a start offset.

  function Node() {
    this.type = null;
    this.start = tokStart;
    this.end = null;
  }
  
  exports.Node = Node;

  function SourceLocation() {
    this.start = tokStartLoc;
    this.end = null;
    if (sourceFile !== null) this.source = sourceFile;
  }

  function startNode() {
    var node = new Node();
    if (options.locations)
      node.loc = new SourceLocation();
    if (options.directSourceFile)
      node.sourceFile = options.directSourceFile;
    if (options.ranges)
      node.range = [tokStart, 0];
    return node;
  }

  // Sometimes, a node is only started *after* the token stream passed
  // its start position. The functions below help storing a position
  // and creating a node from a previous position.

  function storeCurrentPos() {
    return options.locations ? [tokStart, tokStartLoc] : tokStart;
  }

  function startNodeAt(pos) {
    var node = new Node(), start = pos;
    if (options.locations) {
      node.loc = new SourceLocation();
      node.loc.start = start[1];
      start = pos[0];
    }
    node.start = start;
    if (options.directSourceFile)
      node.sourceFile = options.directSourceFile;
    if (options.ranges)
      node.range = [start, 0];

    return node;
  }

  // Finish an AST node, adding `type` and `end` properties.

  function finishNode(node, type) {
    node.type = type;
    node.end = lastEnd;
    if (options.locations)
      node.loc.end = lastEndLoc;
    if (options.ranges)
      node.range[1] = lastEnd;
    return node;
  }

  function finishNodeAt(node, type, pos) {
    if (options.locations) { node.loc.end = pos[1]; pos = pos[0]; }
    node.type = type;
    node.end = pos;
    if (options.ranges)
      node.range[1] = pos;
    return node;
  }

  // Test whether a statement node is the string literal `"use strict"`.

  function isUseStrict(stmt) {
    return options.ecmaVersion >= 5 && stmt.type === "ExpressionStatement" &&
      stmt.expression.type === "Literal" && stmt.expression.value === "use strict";
  }

  // Predicate that tests whether the next token is of the given
  // type, and if yes, consumes it as a side effect.

  function eat(type) {
    if (tokType === type) {
      next();
      return true;
    } else {
      return false;
    }
  }

  // Test whether a semicolon can be inserted at the current position.

  function canInsertSemicolon() {
    return !options.strictSemicolons &&
      (tokType === _eof || tokType === _braceR || newline.test(input.slice(lastEnd, tokStart)));
  }

  // Consume a semicolon, or, failing that, see if we are allowed to
  // pretend that there is a semicolon at this position.

  function semicolon() {
    if (!eat(_semi) && !canInsertSemicolon()) unexpected();
  }

  // Expect a token of a given type. If found, consume it, otherwise,
  // raise an unexpected token error.

  function expect(type) {
    eat(type) || unexpected();
  }

  // Get following char.

  function nextChar() {
    return input.charAt(tokPos);
  }

  // Raise an unexpected token error.

  function unexpected(pos) {
    raise(pos != null ? pos : tokStart, "Unexpected token");
  }

  // Checks if hash object has a property.

  function has(obj, propName) {
    return Object.prototype.hasOwnProperty.call(obj, propName);
  }

  // Convert existing expression atom to assignable pattern
  // if possible.

  function toAssignable(node, allowSpread, checkType) {
    if (options.ecmaVersion >= 6 && node) {
      switch (node.type) {
        case "Identifier":
        case "MemberExpression":
          break;          

        case "ObjectExpression":
          node.type = "ObjectPattern";
          for (var i = 0; i < node.properties.length; i++) {
            var prop = node.properties[i];
            if (prop.type === "Property" && prop.kind !== "init") unexpected(prop.key.start);
            toAssignable(prop.value, false, checkType);
          }
          break;

        case "ArrayExpression":
          node.type = "ArrayPattern";
          for (var i = 0, lastI = node.elements.length - 1; i <= lastI; i++) {
            toAssignable(node.elements[i], i === lastI, checkType);
          }
          break;

        case "SpreadElement":
          if (allowSpread) {
            toAssignable(node.argument, false, checkType);
            checkSpreadAssign(node.argument);
          } else {
            unexpected(node.start);
          }
          break;

        case "AssignmentExpression":
          if (node.operator === "=") {
            node.type = "AssignmentPattern";
          } else {
            unexpected(node.left.end);
          }
          break;

        default:
          if (checkType) unexpected(node.start);
      }
    }
    return node;
  }

  // Parses lvalue (assignable) atom.

  function parseAssignableAtom() {
    if (options.ecmaVersion < 6) return parseIdent();
    switch (tokType) {
      case _name:
        return parseIdent();

      case _bracketL:
        var node = startNode();
        next();
        var elts = node.elements = [], first = true;
        while (!eat(_bracketR)) {
          first ? first = false : expect(_comma);
          if (tokType === _ellipsis) {
            var spread = startNode();
            next();
            spread.argument = parseAssignableAtom();
            checkSpreadAssign(spread.argument);
            elts.push(finishNode(spread, "SpreadElement"));
            expect(_bracketR);
            break;
          }
          elts.push(tokType === _comma ? null : parseMaybeDefault());
        }
        return finishNode(node, "ArrayPattern");

      case _braceL:
        return parseObj(true);

      default:
        unexpected();
    }
  }

  // Parses assignment pattern around given atom if possible.

  function parseMaybeDefault(startPos, left) {
    left = left || parseAssignableAtom();
    if (!eat(_eq)) return left;
    var node = startPos ? startNodeAt(startPos) : startNode();
    node.operator = "=";
    node.left = left;
    node.right = parseMaybeAssign();
    return finishNode(node, "AssignmentPattern");
  }

  // Checks if node can be assignable spread argument.

  function checkSpreadAssign(node) {
    if (node.type !== "Identifier" && node.type !== "ArrayPattern")
      unexpected(node.start);
  }

  // Verify that argument names are not repeated, and it does not
  // try to bind the words `eval` or `arguments`.

  function checkFunctionParam(param, nameHash) {
    switch (param.type) {
      case "Identifier":
        if (isStrictReservedWord(param.name) || isStrictBadIdWord(param.name))
          raise(param.start, "Defining '" + param.name + "' in strict mode");
        if (has(nameHash, param.name))
          raise(param.start, "Argument name clash in strict mode");
        nameHash[param.name] = true;
        break;

      case "ObjectPattern":
        for (var i = 0; i < param.properties.length; i++)
          checkFunctionParam(param.properties[i].value, nameHash);
        break;

      case "ArrayPattern":
        for (var i = 0; i < param.elements.length; i++) {
          var elem = param.elements[i];
          if (elem) checkFunctionParam(elem, nameHash);
        }
        break;
    }
  }

  // Check if property name clashes with already added.
  // Object/class getters and setters are not allowed to clash —
  // either with each other or with an init property — and in
  // strict mode, init properties are also not allowed to be repeated.

  function checkPropClash(prop, propHash) {
    if (options.ecmaVersion >= 6) return;
    var key = prop.key, name;
    switch (key.type) {
      case "Identifier": name = key.name; break;
      case "Literal": name = String(key.value); break;
      default: return;
    }
    var kind = prop.kind || "init", other;
    if (has(propHash, name)) {
      other = propHash[name];
      var isGetSet = kind !== "init";
      if ((strict || isGetSet) && other[kind] || !(isGetSet ^ other.init))
        raise(key.start, "Redefinition of property");
    } else {
      other = propHash[name] = {
        init: false,
        get: false,
        set: false
      };
    }
    other[kind] = true;
  }

  // Verify that a node is an lval — something that can be assigned
  // to.

  function checkLVal(expr, isBinding) {
    switch (expr.type) {
      case "Identifier":
        if (strict && (isStrictBadIdWord(expr.name) || isStrictReservedWord(expr.name)))
          raise(expr.start, (isBinding ? "Binding " : "Assigning to ") + expr.name + " in strict mode");
        break;
      
      case "MemberExpression":
        if (isBinding) raise(expr.start, "Binding to member expression");
        break;

      case "ObjectPattern":
        for (var i = 0; i < expr.properties.length; i++) {
          var prop = expr.properties[i];
          if (prop.type === "Property") prop = prop.value;
          checkLVal(prop, isBinding);
        }
        break;

      case "ArrayPattern":
        for (var i = 0; i < expr.elements.length; i++) {
          var elem = expr.elements[i];
          if (elem) checkLVal(elem, isBinding);
        }
        break;

      case "SpreadProperty":
      case "AssignmentPattern":
      case "SpreadElement":
      case "VirtualPropertyExpression":
        break;

      default:
      raise(expr.start, "Assigning to rvalue");
  }
  }

  // ### Statement parsing

  // Parse a program. Initializes the parser, reads any number of
  // statements, and wraps them in a Program node.  Optionally takes a
  // `program` argument.  If present, the statements will be appended
  // to its body instead of creating a new node.

  function parseTopLevel(node) {
    var first = true;
    if (!node.body) node.body = [];
    while (tokType !== _eof) {
      var stmt = parseStatement(true);
      node.body.push(stmt);
      if (first && isUseStrict(stmt)) setStrict(true);
      first = false;
    }

    lastStart = tokStart;
    lastEnd = tokEnd;
    lastEndLoc = tokEndLoc;
    return finishNode(node, "Program");
  }

  var loopLabel = {kind: "loop"}, switchLabel = {kind: "switch"};

  // Parse a single statement.
  //
  // If expecting a statement and finding a slash operator, parse a
  // regular expression literal. This is to handle cases like
  // `if (foo) /blah/.exec(foo);`, where looking at the previous token
  // does not help.

  function parseStatement(topLevel) {
    if (tokType === _slash || tokType === _assign && tokVal == "/=")
      readToken(true);

    var starttype = tokType, node = startNode(), start = storeCurrentPos();

    // Most types of statements are recognized by the keyword they
    // start with. Many are trivial to parse, some require a bit of
    // complexity.

    switch (starttype) {
    case _break: case _continue: return parseBreakContinueStatement(node, starttype.keyword);
    case _debugger: return parseDebuggerStatement(node);
    case _do: return parseDoStatement(node);
    case _for: return parseForStatement(node);
    case _function: return parseFunctionStatement(node);
    case _class: return parseClass(node, true);
    case _if: return parseIfStatement(node);
    case _return: return parseReturnStatement(node);
    case _switch: return parseSwitchStatement(node);
    case _throw: return parseThrowStatement(node);
    case _try: return parseTryStatement(node);
    case _var: case _let: case _const: return parseVarStatement(node, starttype.keyword);
    case _while: return parseWhileStatement(node);
    case _with: return parseWithStatement(node);
    case _braceL: return parseBlock(); // no point creating a function for this
    case _semi: return parseEmptyStatement(node);
    case _export:
    case _import:
      if (!topLevel && !options.allowImportExportEverywhere)
        raise(tokStart, "'import' and 'export' may only appear at the top level");
      return starttype === _import ? parseImport(node) : parseExport(node);

      // If the statement does not start with a statement keyword or a
      // brace, it's an ExpressionStatement or LabeledStatement. We
      // simply start parsing an expression, and afterwards, if the
      // next token is a colon and the expression was a simple
      // Identifier node, we switch to interpreting it as a label.
    default:
      var maybeName = tokVal, expr = parseExpression(false, false, true);
      if (expr.type === "FunctionDeclaration") return expr;

      if (starttype === _name && expr.type === "Identifier") {
        if (eat(_colon)) {
          return parseLabeledStatement(node, maybeName, expr);
        }

        if (options.ecmaVersion >= 7 && expr.name === "private" && tokType === _name) {
          return parsePrivate(node);
        } else if (expr.name === "declare") {
          if (tokType === _class || tokType === _name || tokType === _function || tokType === _var) {
            return parseDeclare(node);
          }
        } else if (tokType === _name) {
          if (expr.name === "interface") {
            return parseInterface(node);
          } else if (expr.name === "type") {
            return parseTypeAlias(node);
          }
        }
      }

      return parseExpressionStatement(node, expr);
    }
  }
  
  function parseBreakContinueStatement(node, keyword) {
    var isBreak = keyword == "break";
    next();
    if (eat(_semi) || canInsertSemicolon()) node.label = null;
    else if (tokType !== _name) unexpected();
    else {
      node.label = parseIdent();
      semicolon();
    }

    // Verify that there is an actual destination to break or
    // continue to.
    for (var i = 0; i < labels.length; ++i) {
      var lab = labels[i];
      if (node.label == null || lab.name === node.label.name) {
        if (lab.kind != null && (isBreak || lab.kind === "loop")) break;
        if (node.label && isBreak) break;
      }
    }
    if (i === labels.length) raise(node.start, "Unsyntactic " + keyword);
    return finishNode(node, isBreak ? "BreakStatement" : "ContinueStatement");
  }
  
  function parseDebuggerStatement(node) {
    next();
    semicolon();
    return finishNode(node, "DebuggerStatement");
  }
  
  function parseDoStatement(node) {
    next();
    labels.push(loopLabel);
    node.body = parseStatement();
    labels.pop();
    expect(_while);
    node.test = parseParenExpression();
    if (options.ecmaVersion >= 6)
      eat(_semi);
    else
      semicolon();
    return finishNode(node, "DoWhileStatement");
  }
  
  // Disambiguating between a `for` and a `for`/`in` or `for`/`of`
  // loop is non-trivial. Basically, we have to parse the init `var`
  // statement or expression, disallowing the `in` operator (see
  // the second parameter to `parseExpression`), and then check
  // whether the next token is `in` or `of`. When there is no init
  // part (semicolon immediately after the opening parenthesis), it
  // is a regular `for` loop.
  
  function parseForStatement(node) {
    next();
    labels.push(loopLabel);
    expect(_parenL);
    if (tokType === _semi) return parseFor(node, null);
    if (tokType === _var || tokType === _let) {
      var init = startNode(), varKind = tokType.keyword, isLet = tokType === _let;
      next();
      parseVar(init, true, varKind);
      finishNode(init, "VariableDeclaration");
      if ((tokType === _in || (options.ecmaVersion >= 6 && tokType === _name && tokVal === "of")) && init.declarations.length === 1 &&
          !(isLet && init.declarations[0].init))
        return parseForIn(node, init);
      return parseFor(node, init);
    }
    var init = parseExpression(false, true);
    if (tokType === _in || (options.ecmaVersion >= 6 && tokType === _name && tokVal === "of")) {
      checkLVal(init);
      return parseForIn(node, init);
    }
    return parseFor(node, init);
  }
  
  function parseFunctionStatement(node) {
    next();
    return parseFunction(node, true, false);
  }
  
  function parseIfStatement(node) {
    next();
    node.test = parseParenExpression();
    node.consequent = parseStatement();
    node.alternate = eat(_else) ? parseStatement() : null;
    return finishNode(node, "IfStatement");
  }
  
  function parseReturnStatement(node) {
    if (!inFunction && !options.allowReturnOutsideFunction)
      raise(tokStart, "'return' outside of function");
    next();

    // In `return` (and `break`/`continue`), the keywords with
    // optional arguments, we eagerly look for a semicolon or the
    // possibility to insert one.

    if (eat(_semi) || canInsertSemicolon()) node.argument = null;
    else { node.argument = parseExpression(); semicolon(); }
    return finishNode(node, "ReturnStatement");
  }
  
  function parseSwitchStatement(node) {
    next();
    node.discriminant = parseParenExpression();
    node.cases = [];
    expect(_braceL);
    labels.push(switchLabel);

    // Statements under must be grouped (by label) in SwitchCase
    // nodes. `cur` is used to keep the node that we are currently
    // adding statements to.

    for (var cur, sawDefault; tokType != _braceR;) {
      if (tokType === _case || tokType === _default) {
        var isCase = tokType === _case;
        if (cur) finishNode(cur, "SwitchCase");
        node.cases.push(cur = startNode());
        cur.consequent = [];
        next();
        if (isCase) cur.test = parseExpression();
        else {
          if (sawDefault) raise(lastStart, "Multiple default clauses"); sawDefault = true;
          cur.test = null;
        }
        expect(_colon);
      } else {
        if (!cur) unexpected();
        cur.consequent.push(parseStatement());
      }
    }
    if (cur) finishNode(cur, "SwitchCase");
    next(); // Closing brace
    labels.pop();
    return finishNode(node, "SwitchStatement");
  }
  
  function parseThrowStatement(node) {
    next();
    if (newline.test(input.slice(lastEnd, tokStart)))
      raise(lastEnd, "Illegal newline after throw");
    node.argument = parseExpression();
    semicolon();
    return finishNode(node, "ThrowStatement");
  }
  
  function parseTryStatement(node) {
    next();
    node.block = parseBlock();
    node.handler = null;
    if (tokType === _catch) {
      var clause = startNode();
      next();
      expect(_parenL);
      clause.param = parseIdent();
      if (strict && isStrictBadIdWord(clause.param.name))
        raise(clause.param.start, "Binding " + clause.param.name + " in strict mode");
      expect(_parenR);
      clause.guard = null;
      clause.body = parseBlock();
      node.handler = finishNode(clause, "CatchClause");
    }
    node.guardedHandlers = empty;
    node.finalizer = eat(_finally) ? parseBlock() : null;
    if (!node.handler && !node.finalizer)
      raise(node.start, "Missing catch or finally clause");
    return finishNode(node, "TryStatement");
  }
  
  function parseVarStatement(node, kind) {
    next();
    parseVar(node, false, kind);
    semicolon();
    return finishNode(node, "VariableDeclaration");
  }
  
  function parseWhileStatement(node) {
    next();
    node.test = parseParenExpression();
    labels.push(loopLabel);
    node.body = parseStatement();
    labels.pop();
    return finishNode(node, "WhileStatement");
  }
  
  function parseWithStatement(node) {
    if (strict) raise(tokStart, "'with' in strict mode");
    next();
    node.object = parseParenExpression();
    node.body = parseStatement();
    return finishNode(node, "WithStatement");
  }
  
  function parseEmptyStatement(node) {
    next();
    return finishNode(node, "EmptyStatement");
  }
  
  function parseLabeledStatement(node, maybeName, expr) {
    for (var i = 0; i < labels.length; ++i)
      if (labels[i].name === maybeName) raise(expr.start, "Label '" + maybeName + "' is already declared");
    var kind = tokType.isLoop ? "loop" : tokType === _switch ? "switch" : null;
    labels.push({name: maybeName, kind: kind});
    node.body = parseStatement();
    labels.pop();
    node.label = expr;
    return finishNode(node, "LabeledStatement");
  }
  
  function parseExpressionStatement(node, expr) {
    node.expression = expr;
    semicolon();
    return finishNode(node, "ExpressionStatement");
  }

  // Used for constructs like `switch` and `if` that insist on
  // parentheses around their expression.

  function parseParenExpression() {
    expect(_parenL);
    var val = parseExpression();
    expect(_parenR);
    return val;
  }

  // Parse a semicolon-enclosed block of statements, handling `"use
  // strict"` declarations when `allowStrict` is true (used for
  // function bodies).

  function parseBlock(allowStrict) {
    var node = startNode(), first = true, oldStrict;
    node.body = [];
    expect(_braceL);
    while (!eat(_braceR)) {
      var stmt = parseStatement();
      node.body.push(stmt);
      if (first && allowStrict && isUseStrict(stmt)) {
        oldStrict = strict;
        setStrict(strict = true);
      }
      first = false;
    }
    if (oldStrict === false) setStrict(false);
    return finishNode(node, "BlockStatement");
  }

  // Parse a regular `for` loop. The disambiguation code in
  // `parseStatement` will already have parsed the init statement or
  // expression.

  function parseFor(node, init) {
    node.init = init;
    expect(_semi);
    node.test = tokType === _semi ? null : parseExpression();
    expect(_semi);
    node.update = tokType === _parenR ? null : parseExpression();
    expect(_parenR);
    node.body = parseStatement();
    labels.pop();
    return finishNode(node, "ForStatement");
  }

  // Parse a `for`/`in` and `for`/`of` loop, which are almost
  // same from parser's perspective.

  function parseForIn(node, init) {
    var type = tokType === _in ? "ForInStatement" : "ForOfStatement";
    next();
    node.left = init;
    node.right = parseExpression();
    expect(_parenR);
    node.body = parseStatement();
    labels.pop();
    return finishNode(node, type);
  }

  // Parse a list of variable declarations.

  function parseVar(node, noIn, kind) {
    node.declarations = [];
    node.kind = kind;
    for (;;) {
      var decl = startNode();
      decl.id = parseAssignableAtom();
      checkLVal(decl.id, true);

      if (tokType === _colon) {
        decl.id.typeAnnotation = parseTypeAnnotation();
        finishNode(decl.id, decl.id.type);
      }

      decl.init = eat(_eq) ? parseExpression(true, noIn) : (kind === _const.keyword ? unexpected() : null);
      node.declarations.push(finishNode(decl, "VariableDeclarator"));
      if (!eat(_comma)) break;
    }
    return node;
  }

  // ### Expression parsing

  // These nest, from the most general expression type at the top to
  // 'atomic', nondivisible expression types at the bottom. Most of
  // the functions will simply let the function(s) below them parse,
  // and, *if* the syntactic construct they handle is present, wrap
  // the AST node that the inner parser gave them in another node.

  // Parse a full expression. The arguments are used to forbid comma
  // sequences (in argument lists, array literals, or object literals)
  // or the `in` operator (in for loops initalization expressions).

  function parseExpression(noComma, noIn, isStatement) {
    var start = storeCurrentPos();
    var expr = parseMaybeAssign(noIn, false, isStatement);
    if (!noComma && tokType === _comma) {
      var node = startNodeAt(start);
      node.expressions = [expr];
      while (eat(_comma)) node.expressions.push(parseMaybeAssign(noIn));
      return finishNode(node, "SequenceExpression");
    }
    return expr;
  }

  // Parse an assignment expression. This includes applications of
  // operators like `+=`.

  function parseMaybeAssign(noIn, noLess, isStatement) {
    var start = storeCurrentPos();
    var left = parseMaybeConditional(noIn, noLess, isStatement);
    if (tokType.isAssign) {
      var node = startNodeAt(start);
      node.operator = tokVal;
      node.left = tokType === _eq ? toAssignable(left) : left;
      checkLVal(left);
      next();
      node.right = parseMaybeAssign(noIn);
      return finishNode(node, "AssignmentExpression");
    }
    return left;
  }

  // Parse a ternary conditional (`?:`) operator.

  function parseMaybeConditional(noIn, noLess, isStatement) {
    var start = storeCurrentPos();
    var expr = parseExprOps(noIn, noLess, isStatement);
    if (eat(_question)) {
      var node = startNodeAt(start);
      if (eat(_eq)) {
        var left = node.left = toAssignable(expr);
        if (left.type !== "MemberExpression") raise(left.start, "You can only use member expressions in memoization assignment");
        node.right = parseMaybeAssign(noIn);
        node.operator = "?=";
        return finishNode(node, "AssignmentExpression");
      }
      node.test = expr;
      node.consequent = parseExpression(true);
      expect(_colon);
      node.alternate = parseExpression(true, noIn);
      return finishNode(node, "ConditionalExpression");
    }
    return expr;
  }

  // Start the precedence parser.

  function parseExprOps(noIn, noLess, isStatement) {
    var start = storeCurrentPos();
    return parseExprOp(parseMaybeUnary(isStatement), start, -1, noIn, noLess);
  }

  // Parse binary operators with the operator precedence parsing
  // algorithm. `left` is the left-hand side of the operator.
  // `minPrec` provides context that allows the function to stop and
  // defer further parser to one of its callers when it encounters an
  // operator that has a lower precedence than the set it is parsing.

  function parseExprOp(left, leftStart, minPrec, noIn, noLess) {
    var prec = tokType.binop;
    if (prec != null && (!noIn || tokType !== _in) && (!noLess || tokType !== _lt)) {
      if (prec > minPrec) {
        var node = startNodeAt(leftStart);
        node.left = left;
        node.operator = tokVal;
        var op = tokType;
        next();
        var start = storeCurrentPos();
        node.right = parseExprOp(parseMaybeUnary(), start, prec, noIn);
        finishNode(node, (op === _logicalOR || op === _logicalAND) ? "LogicalExpression" : "BinaryExpression");
        return parseExprOp(node, leftStart, minPrec, noIn);
      }
    }
    return left;
  }

  // Parse unary operators, both prefix and postfix.

  function parseMaybeUnary(isStatement) {
    if (tokType.prefix) {
      var node = startNode(), update = tokType.isUpdate, nodeType;
      if (tokType === _ellipsis) {
        nodeType = "SpreadElement";
      } else {
        nodeType = update ? "UpdateExpression" : "UnaryExpression";
      node.operator = tokVal;
      node.prefix = true;
      }
      tokRegexpAllowed = true;
      next();
      node.argument = parseMaybeUnary();
      if (update) checkLVal(node.argument);
      else if (strict && node.operator === "delete" &&
               node.argument.type === "Identifier")
        raise(node.start, "Deleting local variable in strict mode");
      return finishNode(node, nodeType);
    }
    var start = storeCurrentPos();
    var expr = parseExprSubscripts(isStatement);
    while (tokType.postfix && !canInsertSemicolon()) {
      var node = startNodeAt(start);
      node.operator = tokVal;
      node.prefix = false;
      node.argument = expr;
      checkLVal(expr);
      next();
      expr = finishNode(node, "UpdateExpression");
    }
    return expr;
  }

  // Parse call, dot, and `[]`-subscript expressions.

  function parseExprSubscripts(isStatement) {
    var start = storeCurrentPos();
    return parseSubscripts(parseExprAtom(isStatement), start);
  }

  function parseSubscripts(base, start, noCalls) {
    if (options.playground && eat(_hash)) {
      var node = startNodeAt(start);
      node.object = base;
      node.property = parseIdent(true);
      if (eat(_parenL)) {
        node.arguments = parseExprList(_parenR, false);
      } else {
        node.arguments = [];
      }
      return parseSubscripts(finishNode(node, "BindMemberExpression"), start, noCalls);
    } else if (eat(_paamayimNekudotayim)) {
      var node = startNodeAt(start);
      node.object = base;
      node.property = parseIdent(true);
      return parseSubscripts(finishNode(node, "VirtualPropertyExpression"), start, noCalls);
    } else if (eat(_dot)) {
      var node = startNodeAt(start);
      node.object = base;
      node.property = parseIdent(true);
      node.computed = false;
      return parseSubscripts(finishNode(node, "MemberExpression"), start, noCalls);
    } else if (eat(_bracketL)) {
      var node = startNodeAt(start);
      node.object = base;
      node.property = parseExpression();
      node.computed = true;
      expect(_bracketR);
      return parseSubscripts(finishNode(node, "MemberExpression"), start, noCalls);
    } else if (!noCalls && eat(_parenL)) {
      var node = startNodeAt(start);
      node.callee = base;
      node.arguments = parseExprList(_parenR, false);
      return parseSubscripts(finishNode(node, "CallExpression"), start, noCalls);
    } else if (tokType === _template) {
      var node = startNodeAt(start);
      node.tag = base;
      node.quasi = parseTemplate();
      return parseSubscripts(finishNode(node, "TaggedTemplateExpression"), start, noCalls);
    } return base;
  }

  // Parse an atomic expression — either a single token that is an
  // expression, an expression started by a keyword like `function` or
  // `new`, or an expression wrapped in punctuation like `()`, `[]`,
  // or `{}`.

  function parseExprAtom(isStatement) {
    switch (tokType) {
    case _this:
      var node = startNode();
      next();
      return finishNode(node, "ThisExpression");

    case _at:
      var start = storeCurrentPos();
      var node = startNode();
      var thisNode = startNode();
      next();
      node.object = finishNode(thisNode, "ThisExpression");
      node.property = parseSubscripts(parseIdent(), start);
      node.computed = false;
      return finishNode(node, "MemberExpression");
    
    case _yield:
      if (inGenerator) return parseYield();

    case _name:
      var start = storeCurrentPos();
      var node = startNode();
      var id = parseIdent(tokType !== _name);

      if (options.ecmaVersion >= 7) {
        // async functions!
        if (id.name === "async") {
          // arrow functions
          if (tokType === _parenL) {
            next();
            var oldParenL = ++metParenL;
            if (tokType !== _parenR) {
              val = parseExpression();
              exprList = val.type === "SequenceExpression" ? val.expressions : [val];
            } else {
              exprList = [];
            }
            expect(_parenR);
            // if '=>' follows '(...)', convert contents to arguments
            if (metParenL === oldParenL && eat(_arrow)) {
              return parseArrowExpression(node, exprList, true);
            } else {
              node.callee = id;
              node.arguments = exprList;
              return parseSubscripts(finishNode(node, "CallExpression"), start);
            }
          } else if (tokType === _name) {
            id = parseIdent();
            if (eat(_arrow)) {
              return parseArrowExpression(node, [id], true);
            }
            return id;
          }

          // normal functions
          if (tokType === _function) {
            // no line terminator after `async` contextual keyword
            if (canInsertSemicolon()) return id;

            next();
            return parseFunction(node, isStatement, true);
          }
        } else if (id.name === "await") {
          if (inAsync) return parseAwait(node);
        }
      }

      if (eat(_arrow)) {
        return parseArrowExpression(node, [id]);
      }
      return id;
      
    case _regexp:
      var node = startNode();
      node.regex = {pattern: tokVal.pattern, flags: tokVal.flags};
      node.value = tokVal.value;
      node.raw = input.slice(tokStart, tokEnd);
      next();
      return finishNode(node, "Literal");

    case _num: case _string: case _xjsText:
      var node = startNode();
      node.value = tokVal;
      node.raw = input.slice(tokStart, tokEnd);
      next();
      return finishNode(node, "Literal");

    case _null: case _true: case _false:
      var node = startNode();
      node.value = tokType.atomValue;
      node.raw = tokType.keyword;
      next();
      return finishNode(node, "Literal");

    case _parenL:
      var start = storeCurrentPos();
      var val, exprList;
      next();
      // check whether this is generator comprehension or regular expression
      if (options.ecmaVersion >= 7 && tokType === _for) {
        val = parseComprehension(startNodeAt(start), true);
      } else {
        var oldParenL = ++metParenL;
        if (tokType !== _parenR) {
          val = parseExpression();
          exprList = val.type === "SequenceExpression" ? val.expressions : [val];
        } else {
          exprList = [];
        }
        expect(_parenR);
        // if '=>' follows '(...)', convert contents to arguments
        if (metParenL === oldParenL && eat(_arrow)) {
          val = parseArrowExpression(startNodeAt(start), exprList);
        } else {
          // forbid '()' before everything but '=>'
          if (!val) unexpected(lastStart);
          // forbid '...' in sequence expressions
          if (options.ecmaVersion >= 6) {
            for (var i = 0; i < exprList.length; i++) {
              if (exprList[i].type === "SpreadElement") unexpected();
            }
          }

          if (options.preserveParens) {
            var par = startNodeAt(start);
            par.expression = val;
            val = finishNode(par, "ParenthesizedExpression");
          }
        }
      }
      return val;

    case _bracketL:
      var node = startNode();
      next();
      // check whether this is array comprehension or regular array
      if (options.ecmaVersion >= 7 && tokType === _for) {
        return parseComprehension(node, false);
        }
      node.elements = parseExprList(_bracketR, true, true);
      return finishNode(node, "ArrayExpression");

    case _braceL:
      return parseObj();

    case _function:
      var node = startNode();
      next();
      return parseFunction(node, false, false);

    case _class:
      return parseClass(startNode(), false);

    case _new:
      return parseNew();

    case _template:
      return parseTemplate();

    case _lt:
      return parseXJSElement();

    case _hash:
      return parseBindFunctionExpression();

    default:
      unexpected();
    }
  }

  function parseBindFunctionExpression() {
    var node = startNode();
    next();

    var start = storeCurrentPos();
    node.callee = parseSubscripts(parseExprAtom(), start, true);

    if (eat(_parenL)) {
      node.arguments = parseExprList(_parenR, false);
    } else {
      node.arguments = [];
    }

    return finishNode(node, "BindFunctionExpression");
  }

  // New's precedence is slightly tricky. It must allow its argument
  // to be a `[]` or dot subscript expression, but not a call — at
  // least, not without wrapping it in parentheses. Thus, it uses the

  function parseNew() {
    var node = startNode();
    next();
    var start = storeCurrentPos();
    node.callee = parseSubscripts(parseExprAtom(), start, true);
    if (eat(_parenL)) node.arguments = parseExprList(_parenR, false);
    else node.arguments = empty;
    return finishNode(node, "NewExpression");
  }

  // Parse template expression.

  function parseTemplateElement() {
    var elem = startNodeAt(options.locations ? [tokStart + 1, tokStartLoc.offset(1)] : tokStart + 1);
    elem.value = tokVal;
    elem.tail = input.charCodeAt(tokEnd - 1) !== 123; // '{'
    next();
    var endOff = elem.tail ? 1 : 2;
    return finishNodeAt(elem, "TemplateElement", options.locations ? [lastEnd - endOff, lastEndLoc.offset(-endOff)] : lastEnd - endOff);
  }

  function parseTemplate() {
    var node = startNode();
    node.expressions = [];
    var curElt = parseTemplateElement();
    node.quasis = [curElt];
    while (!curElt.tail) {
      node.expressions.push(parseExpression());
      if (tokType !== _templateContinued) unexpected();
      node.quasis.push(curElt = parseTemplateElement());
    }
    return finishNode(node, "TemplateLiteral");
  }

  // Parse an object literal.

  function parseObj(isPattern) {
    var node = startNode(), first = true, propHash = {};
    node.properties = [];
    next();
    while (!eat(_braceR)) {
      if (!first) {
        expect(_comma);
        if (options.allowTrailingCommas && eat(_braceR)) break;
      } else first = false;

      var prop = startNode(), start, isGenerator = false, isAsync = false;
      if (options.ecmaVersion >= 7 && tokType === _ellipsis) {
        prop = parseMaybeUnary();
        prop.type = "SpreadProperty";
        node.properties.push(prop);
        continue;
      }
      if (options.ecmaVersion >= 6) {
        prop.method = false;
        prop.shorthand = false;
        if (isPattern) {
          start = storeCurrentPos();
        } else {
          isGenerator = eat(_star);
        }
      }
      if (options.ecmaVersion >= 7 && tokType === _name && tokVal === "async") {
        var asyncId = parseIdent();
        if (tokType === _colon || tokType === _parenL) {
          prop.key = asyncId;
        } else {
          isAsync = true;
          parsePropertyName(prop);
        }
      } else {
        parsePropertyName(prop);
      }
      var typeParameters
      if (tokType === _lt) {
        typeParameters = parseTypeParameterDeclaration();
        if (tokType !== _parenL) unexpected();
      }
      if (eat(_colon)) {
        prop.value = isPattern ? parseMaybeDefault(start) : parseMaybeAssign();
        prop.kind = "init";
      } else if (options.ecmaVersion >= 6 && tokType === _parenL) {
        if (isPattern) unexpected();
        prop.kind = "init";
        prop.method = true;
        prop.value = parseMethod(isGenerator, isAsync);
      } else if (options.ecmaVersion >= 5 && !prop.computed && prop.key.type === "Identifier" &&
                 (prop.key.name === "get" || prop.key.name === "set"|| (options.playground && prop.key.name === "memo")) &&
                 (tokType != _comma && tokType != _braceR)) {
        if (isGenerator || isAsync || isPattern) unexpected();
        prop.kind = prop.key.name;
        parsePropertyName(prop);
        prop.value = parseMethod(false, false);
      } else if (options.ecmaVersion >= 6 && !prop.computed && prop.key.type === "Identifier") {
        prop.kind = "init";
        prop.value = isPattern ? parseMaybeDefault(start, prop.key) : prop.key;
        prop.shorthand = true;
      } else unexpected();

      prop.value.typeParameters = typeParameters;
      checkPropClash(prop, propHash);
      node.properties.push(finishNode(prop, "Property"));
    }
    return finishNode(node, isPattern ? "ObjectPattern" : "ObjectExpression");
  }

  function parsePropertyName(prop) {
    if (options.ecmaVersion >= 6) {
      if (eat(_bracketL)) {
        prop.computed = true;
        prop.key = parseExpression();
        expect(_bracketR);
        return;
      } else {
        prop.computed = false;
      }
    }
    prop.key = (tokType === _num || tokType === _string) ? parseExprAtom() : parseIdent(true);
  }

  // Initialize empty function node.

  function initFunction(node, isAsync) {
    node.id = null;
    node.params = [];
    if (options.ecmaVersion >= 6) {
      node.defaults = [];
      node.rest = null;
      node.generator = false;
    }
    if (options.ecmaVersion >= 7) {
      node.async = isAsync;
    }
  }

  // Parse a function declaration or literal (depending on the
  // `isStatement` parameter).

  function parseFunction(node, isStatement, isAsync, allowExpressionBody) {
    initFunction(node, isAsync);
    if (options.ecmaVersion >= 6) {
      node.generator = eat(_star);
    }
    if (isStatement || tokType === _name) {
      node.id = parseIdent();
    }
    if (tokType === _lt) {
      node.typeParameters = parseTypeParameterDeclaration();
    }
    parseFunctionParams(node);
    parseFunctionBody(node, allowExpressionBody);
    return finishNode(node, isStatement ? "FunctionDeclaration" : "FunctionExpression");
  }

  // Parse object or class method.

  function parseMethod(isGenerator, isAsync) {
    var node = startNode();
    initFunction(node, isAsync);
    parseFunctionParams(node);
    var allowExpressionBody;
    if (options.ecmaVersion >= 6) {
      node.generator = isGenerator;
      allowExpressionBody = true;
    } else {
      allowExpressionBody = false;
    }
    parseFunctionBody(node, allowExpressionBody);
    return finishNode(node, "FunctionExpression");
  }

  // Parse arrow function expression with given parameters.

  function parseArrowExpression(node, params, isAsync) {
    initFunction(node, isAsync);

    var defaults = node.defaults, hasDefaults = false;
    
    for (var i = 0, lastI = params.length - 1; i <= lastI; i++) {
      var param = params[i];

      if (param.type === "AssignmentExpression" && param.operator === "=") {
        hasDefaults = true;
        params[i] = param.left;
        defaults.push(param.right);
      } else {
        toAssignable(param, i === lastI, true);
        defaults.push(null);
        if (param.type === "SpreadElement") {
          params.length--;
          node.rest = param.argument;
          break;
        }
      }
    }

    node.params = params;
    if (!hasDefaults) node.defaults = [];

    parseFunctionBody(node, true);
    return finishNode(node, "ArrowFunctionExpression");
  }

  // Parse function parameters.

  function parseFunctionParams(node) {
    var defaults = [], hasDefaults = false;

    expect(_parenL);
    for (;;) {
      if (eat(_parenR)) {
        break;
      } else if (options.ecmaVersion >= 6 && eat(_ellipsis)) {
        node.rest = parseAssignableAtom();
        checkSpreadAssign(node.rest);
        parseFunctionParam(node.rest);
        expect(_parenR);
        defaults.push(null);
        break;
      } else {
        var param = parseAssignableAtom();
        parseFunctionParam(param);
        node.params.push(param);

        if (options.ecmaVersion >= 6) {
          if (eat(_eq)) {
            hasDefaults = true;
            defaults.push(parseExpression(true));
          } else {
            defaults.push(null);
          }
        }
        if (!eat(_comma)) {
          expect(_parenR);
          break;
        }
      }
    }

    if (hasDefaults) node.defaults = defaults;

    if (tokType === _colon) {
      node.returnType = parseTypeAnnotation();
    }
  }

  function parseFunctionParam(param) {
    if (tokType === _colon) {
      param.typeAnnotation = parseTypeAnnotation();
    } else if (eat(_question)) {
      param.optional = true;
    }
    finishNode(param, param.type);
  }

  // Parse function body and check parameters.

  function parseFunctionBody(node, allowExpression) {
    var isExpression = allowExpression && tokType !== _braceL;

    var oldInAsync = inAsync;
    inAsync = node.async;
    if (isExpression) {
      node.body = parseExpression(true);
      node.expression = true;
    } else {
    // Start a new scope with regard to labels and the `inFunction`
    // flag (restore them to their old value afterwards).
      var oldInFunc = inFunction, oldInGen = inGenerator, oldLabels = labels;
      inFunction = true; inGenerator = node.generator; labels = [];
      node.body = parseBlock(true);
      node.expression = false;
      inFunction = oldInFunc; inGenerator = oldInGen; labels = oldLabels;
    }
    inAsync = oldInAsync;

    // If this is a strict mode function, verify that argument names
    // are not repeated, and it does not try to bind the words `eval`
    // or `arguments`.
    if (strict || !isExpression && node.body.body.length && isUseStrict(node.body.body[0])) {
      var nameHash = {};
      if (node.id)
        checkFunctionParam(node.id, {});
      for (var i = 0; i < node.params.length; i++)
        checkFunctionParam(node.params[i], nameHash);
      if (node.rest)
        checkFunctionParam(node.rest, nameHash);
    }
  }

  function parsePrivate(node) {
    node.declarations = [];
    do {
      node.declarations.push(parseIdent());
    } while (eat(_comma));
    semicolon();
    return finishNode(node, "PrivateDeclaration");
  }

  // Parse a class declaration or literal (depending on the
  // `isStatement` parameter).
  
  function parseClass(node, isStatement) {
    next();
    node.id = tokType === _name ? parseIdent() : isStatement ? unexpected() : null;
    if (tokType === _lt) {
      node.typeParameters = parseTypeParameterDeclaration();
    }
    node.superClass = eat(_extends) ? parseMaybeAssign(false, true) : null;
    if (node.superClass && tokType === _lt) {
      node.superTypeParameters = parseTypeParameterInstantiation();
    }
    if (tokType === _name && tokVal === "implements") {
      next();
      node.implements = parseClassImplements();
    }
    var classBody = startNode();
    classBody.body = [];
    expect(_braceL);
    while (!eat(_braceR)) {
      while (eat(_semi));
      if (tokType === _braceR) continue;
      var method = startNode();
      if (options.ecmaVersion >= 7 && tokType === _name && tokVal === "private") {
        next();
        classBody.body.push(parsePrivate(method));
        continue;
      }
      if (tokType === _name && tokVal === "static") {
        next();
        method['static'] = true;
      } else {
        method['static'] = false;
      }
      var isAsync = false;
      var isGenerator = eat(_star);
      if (options.ecmaVersion >= 7 && !isGenerator && tokType === _name && tokVal === "async") {
        var asyncId = parseIdent();
        if (tokType === _colon || tokType === _parenL) {
          method.key = asyncId;
        } else {
          isAsync = true;
          parsePropertyName(method);
        }
      } else {
        parsePropertyName(method);
      }
      if (tokType !== _parenL && !method.computed && method.key.type === "Identifier" &&
          (method.key.name === "get" || method.key.name === "set" || (options.playground && method.key.name === "memo"))) {
        if (isGenerator || isAsync) unexpected();
        method.kind = method.key.name;
        parsePropertyName(method);
      } else {
        method.kind = "";
      }
      if (tokType === _colon) {
        if (isGenerator || isAsync) unexpected();
        method.typeAnnotation = parseTypeAnnotation();
        semicolon();
        classBody.body.push(finishNode(method, "ClassProperty"));
      } else {
        var typeParameters;
        if (tokType === _lt) {
          typeParameters = parseTypeParameterDeclaration();
        }
        method.value = parseMethod(isGenerator, isAsync);
        method.value.typeParameters = typeParameters;
        classBody.body.push(finishNode(method, "MethodDefinition"));
      }
    }
    node.body = finishNode(classBody, "ClassBody");
    return finishNode(node, isStatement ? "ClassDeclaration" : "ClassExpression");
  }

  function parseClassImplements() {
      var implemented = [];

      do {
        var node = startNode();
        node.id = parseIdent();
        if (tokType === _lt) {
            node.typeParameters = parseTypeParameterInstantiation();
        } else {
            node.typeParameters = null;
        }
        implemented.push(finishNode(node, "ClassImplements"));
      } while(eat(_comma));

      return implemented;
  }

  // Parses a comma-separated list of expressions, and returns them as
  // an array. `close` is the token type that ends the list, and
  // `allowEmpty` can be turned on to allow subsequent commas with
  // nothing in between them to be parsed as `null` (which is needed
  // for array literals).

  function parseExprList(close, allowTrailingComma, allowEmpty) {
    var elts = [], first = true;
    while (!eat(close)) {
      if (!first) {
        expect(_comma);
        if (allowTrailingComma && options.allowTrailingCommas && eat(close)) break;
      } else first = false;

      if (allowEmpty && tokType === _comma) elts.push(null);
      else elts.push(parseExpression(true));
    }
    return elts;
  }

  // Parse the next token as an identifier. If `liberal` is true (used
  // when parsing properties), it will also convert keywords into
  // identifiers.

  function parseIdent(liberal) {
    var node = startNode();
    if (liberal && options.forbidReserved == "everywhere") liberal = false;
    if (tokType === _name) {
      if (!liberal &&
          (options.forbidReserved &&
           (options.ecmaVersion === 3 ? isReservedWord3 : isReservedWord5)(tokVal) ||
           strict && isStrictReservedWord(tokVal)) &&
          input.slice(tokStart, tokEnd).indexOf("\\") == -1)
        raise(tokStart, "The keyword '" + tokVal + "' is reserved");
      node.name = tokVal;
    } else if (liberal && tokType.keyword) {
      node.name = tokType.keyword;
    } else {
      unexpected();
    }
    tokRegexpAllowed = false;
    next();
    return finishNode(node, "Identifier");
  }

  // Parses module export declaration.

  function parseExport(node) {
    next();
    // export var|const|let|function|class ...;
    if (tokType === _var || tokType === _const || tokType === _let || tokType === _function || tokType === _class || tokType === _name && tokVal === 'async') {
      node.declaration = parseStatement();
      node['default'] = false;
      node.specifiers = null;
      node.source = null;
    } else
    // export default ...;
    if (eat(_default)) {
      var declar = node.declaration = parseExpression(true);
      if (declar.id) {
        if (declar.type === "FunctionExpression") {
          declar.type = "FunctionDeclaration";
        } else if (declar.type === "ClassExpression") {
          declar.type = "ClassDeclaration";
        }
      }
      node['default'] = true;
      node.specifiers = null;
      node.source = null;
      semicolon();
    } else {
      // export * from '...';
      // export { x, y as z } [from '...'];
      var isBatch = tokType === _star;
      node.declaration = null;
      node['default'] = false;
      node.specifiers = parseExportSpecifiers();
      if (tokType === _name && tokVal === "from") {
        next();
        node.source = tokType === _string ? parseExprAtom() : unexpected();
      } else {
        if (isBatch) unexpected();
        node.source = null;
      }
      semicolon();
    }
    return finishNode(node, "ExportDeclaration");
  }

  // Parses a comma-separated list of module exports.

  function parseExportSpecifiers() {
    var nodes = [], first = true;
    if (tokType === _star) {
      // export * from '...'
      var node = startNode();
      next();
      nodes.push(finishNode(node, "ExportBatchSpecifier"));
    } else {
      // export { x, y as z } [from '...']
      expect(_braceL);
      while (!eat(_braceR)) {
        if (!first) {
          expect(_comma);
          if (options.allowTrailingCommas && eat(_braceR)) break;
        } else first = false;

        var node = startNode();
        node.id = parseIdent(tokType === _default);
        if (tokType === _name && tokVal === "as") {
          next();
          node.name = parseIdent(true);
        } else {
          node.name = null;
        }
        nodes.push(finishNode(node, "ExportSpecifier"));
      }
    }
    return nodes;
  }

  // Parses import declaration.

  function parseImport(node) {
    next();
    // import '...';
    if (tokType === _string) {
      node.specifiers = [];
      node.source = parseExprAtom();
    } else {
      node.specifiers = parseImportSpecifiers();
      if (tokType !== _name || tokVal !== "from") unexpected();
      next();
      node.source = tokType === _string ? parseExprAtom() : unexpected();
    }
    semicolon();
    return finishNode(node, "ImportDeclaration");
  }

  // Parses a comma-separated list of module imports.

  function parseImportSpecifiers() {
    var nodes = [], first = true;
    if (tokType === _name) {
      // import defaultObj, { x, y as z } from '...'
      var node = startNode();
      node.id = startNode();
      node.name = parseIdent();
      checkLVal(node.name, true);
      node.id.name = "default";
      finishNode(node.id, "Identifier");
      nodes.push(finishNode(node, "ImportSpecifier"));
      if (!eat(_comma)) return nodes;
    }
    if (tokType === _star) {
      var node = startNode();
      next();
      if (tokType !== _name || tokVal !== "as") unexpected();
      next();
      node.name = parseIdent();
      checkLVal(node.name, true);
      nodes.push(finishNode(node, "ImportBatchSpecifier"));
      return nodes;
    }
    expect(_braceL);
    while (!eat(_braceR)) {
      if (!first) {
        expect(_comma);
        if (options.allowTrailingCommas && eat(_braceR)) break;
      } else first = false;

      var node = startNode();
      node.id = parseIdent(true);
      if (tokType === _name && tokVal === "as") {
        next();
        node.name = parseIdent();
      } else {
        node.name = null;
      }
      checkLVal(node.name || node.id, true);
      node['default'] = false;
      nodes.push(finishNode(node, "ImportSpecifier"));
    }
    return nodes;
  }

  // Parses yield expression inside generator.

  function parseYield() {
    var node = startNode();
    next();
    if (eat(_semi) || canInsertSemicolon()) {
      node.delegate = false;
      node.argument = null;
    } else {
      node.delegate = eat(_star);
      node.argument = parseExpression(true);
    }
    return finishNode(node, "YieldExpression");
  }

  // Parses await expression inside async function.

  function parseAwait(node) {
    if (eat(_semi) || canInsertSemicolon()) {
      unexpected();
    }
    node.delegate = eat(_star);
    node.argument = parseExpression(true);
    return finishNode(node, "AwaitExpression");
  }

  // Parses array and generator comprehensions.

  function parseComprehension(node, isGenerator) {
    node.blocks = [];
    while (tokType === _for) {
      var block = startNode();
      next();
      expect(_parenL);
      block.left = parseAssignableAtom();
      checkLVal(block.left, true);
      if (tokType !== _name || tokVal !== "of") unexpected();
      next();
      // `of` property is here for compatibility with Esprima's AST
      // which also supports deprecated [for (... in ...) expr]
      block.of = true;
      block.right = parseExpression();
      expect(_parenR);
      node.blocks.push(finishNode(block, "ComprehensionBlock"));
    }
    node.filter = eat(_if) ? parseParenExpression() : null;
    node.body = parseExpression();
    expect(isGenerator ? _parenR : _bracketR);
    node.generator = isGenerator;
    return finishNode(node, "ComprehensionExpression");
  }

  // Transforms JSX element name to string.

  function getQualifiedXJSName(object) {
    if (object.type === "XJSIdentifier") {
      return object.name;
    }
    if (object.type === "XJSNamespacedName") {
      return object.namespace.name + ':' + object.name.name;
    }
    if (object.type === "XJSMemberExpression") {
      return (
        getQualifiedXJSName(object.object) + '.' +
        getQualifiedXJSName(object.property)
      );
    }
  }

  // Parse next token as JSX identifier

  function parseXJSIdentifier() {
    var node = startNode();
    if (tokType === _xjsName) {
      node.name = tokVal;
    } else if (tokType.keyword) {
      node.name = tokType.keyword;
    } else {
      unexpected();
    }
    tokRegexpAllowed = false;
    next();
    return finishNode(node, "XJSIdentifier");
  }

  // Parse namespaced identifier.

  function parseXJSNamespacedName() {
    var node = startNode();

    node.namespace = parseXJSIdentifier();
    expect(_colon);
    node.name = parseXJSIdentifier();

    return finishNode(node, "XJSNamespacedName");
  }

  // Parse JSX object.

  function parseXJSMemberExpression() {
    var start = storeCurrentPos();
    var node = parseXJSIdentifier();

    while (eat(_dot)) {
      var newNode = startNodeAt(start);
      newNode.object = node;
      newNode.property = parseXJSIdentifier();
      node = finishNode(newNode, "XJSMemberExpression");
    }

    return node;
  }

  // Parses element name in any form - namespaced, object
  // or single identifier.

  function parseXJSElementName() {
    switch (nextChar()) {
      case ':':
        return parseXJSNamespacedName();

      case '.':
        return parseXJSMemberExpression();

      default:
        return parseXJSIdentifier();
    }
  }

  // Parses attribute name as optionally namespaced identifier.

  function parseXJSAttributeName() {
    if (nextChar() === ':') {
      return parseXJSNamespacedName();
    }

    return parseXJSIdentifier();
  }

  // Parses any type of JSX attribute value.

  function parseXJSAttributeValue() {
    switch (tokType) {
      case _braceL:
        var node = parseXJSExpressionContainer();
        if (node.expression.type === "XJSEmptyExpression") {
          raise(
            node.start,
              'XJS attributes must only be assigned a non-empty ' +
              'expression'
          );
        }
        return node;

      case _lt:
        return parseXJSElement();

      case _xjsText:
        return parseExprAtom();

      default:
        raise(tokStart, "XJS value should be either an expression or a quoted XJS text");
    }
  }

  // XJSEmptyExpression is unique type since it doesn't actually parse anything,
  // and so it should start at the end of last read token (left brace) and finish
  // at the beginning of the next one (right brace).

  function parseXJSEmptyExpression() {
    if (tokType !== _braceR) {
      unexpected();
    }

    var tmp;

    tmp = tokStart;
    tokStart = lastEnd;
    lastEnd = tmp;

    tmp = tokStartLoc;
    tokStartLoc = lastEndLoc;
    lastEndLoc = tmp;

    return finishNode(startNode(), "XJSEmptyExpression");
  }

  // Parses JSX expression enclosed into curly brackets.

  function parseXJSExpressionContainer() {
    var node = startNode();

    var origInXJSTag = inXJSTag,
      origInXJSChild = inXJSChild;

    inXJSTag = false;
    inXJSChild = false;

    next();
    node.expression = tokType === _braceR ? parseXJSEmptyExpression() : parseExpression();

    inXJSTag = origInXJSTag;
    inXJSChild = origInXJSChild;

    if (inXJSChild) {
      tokPos = tokEnd;
    }
    expect(_braceR);
    return finishNode(node, "XJSExpressionContainer");
  }

  // Parses following JSX attribute name-value pair.

  function parseXJSAttribute() {
    if (tokType === _braceL) {
      var tokStart1 = tokStart, tokStartLoc1 = tokStartLoc;

      var origInXJSTag = inXJSTag;
      inXJSTag = false;

      next();
      if (tokType !== _ellipsis) unexpected();
      var node = parseMaybeUnary();

      inXJSTag = origInXJSTag;

      expect(_braceR);
      node.type = "XJSSpreadAttribute";
      
      node.start = tokStart1;
      node.end = lastEnd;
      if (options.locations) {
        node.loc.start = tokStartLoc1;
        node.loc.end = lastEndLoc;
      }
      if (options.ranges) {
        node.range = [tokStart1, lastEnd];
      }

      return node;
    }

    var node = startNode();
    node.name = parseXJSAttributeName();

    // HTML empty attribute
    if (tokType === _eq) {
      next();
      node.value = parseXJSAttributeValue();
    } else {
      node.value = null;
    }

    return finishNode(node, "XJSAttribute");
  }

  // Parses any type of JSX contents (expression, text or another tag).

  function parseXJSChild() {
    switch (tokType) {
      case _braceL:
        return parseXJSExpressionContainer();

      case _xjsText:
        return parseExprAtom();

      default:
        return parseXJSElement();
    }
  }

  // Parses JSX open tag.

  function parseXJSOpeningElement() {
    var node = startNode(), attributes = node.attributes = [];

    var origInXJSChild = inXJSChild;
    var origInXJSTag = inXJSTag;
    inXJSChild = false;
    inXJSTag = true;

    next();

    node.name = parseXJSElementName();

    while (tokType !== _eof && tokType !== _slash && tokType !== _gt) {
      attributes.push(parseXJSAttribute());
    }

    inXJSTag = false;

    if (node.selfClosing = !!eat(_slash)) {
      inXJSTag = origInXJSTag;
      inXJSChild = origInXJSChild;
    } else {
      inXJSChild = true;
    }

    expect(_gt);

    return finishNode(node, "XJSOpeningElement");
  }

  // Parses JSX closing tag.

  function parseXJSClosingElement() {
    var node = startNode();
    var origInXJSChild = inXJSChild;
    var origInXJSTag = inXJSTag;
    inXJSChild = false;
    inXJSTag = true;
    tokRegexpAllowed = false;
    expect(_ltSlash);
    node.name = parseXJSElementName();
    skipSpace();
    // A valid token is expected after >, so parser needs to know
    // whether to look for a standard JS token or an XJS text node
    inXJSChild = origInXJSChild;
    inXJSTag = origInXJSTag;
    tokRegexpAllowed = false;
    if (inXJSChild) {
      tokPos = tokEnd;
    }
    expect(_gt);
    return finishNode(node, "XJSClosingElement");
  }

  // Parses entire JSX element, including it's opening tag,
  // attributes, contents and closing tag.

  function parseXJSElement() {
    var node = startNode();

    var children = [];

    var origInXJSChild = inXJSChild;
    var openingElement = parseXJSOpeningElement();
    var closingElement = null;

    if (!openingElement.selfClosing) {
      while (tokType !== _eof && tokType !== _ltSlash) {
        inXJSChild = true;
        children.push(parseXJSChild());
      }
      inXJSChild = origInXJSChild;
      closingElement = parseXJSClosingElement();
      if (getQualifiedXJSName(closingElement.name) !== getQualifiedXJSName(openingElement.name)) {
        raise(
          closingElement.start,
          "Expected corresponding XJS closing tag for '" + getQualifiedXJSName(openingElement.name) + "'"
        );
      }
    }

    // When (erroneously) writing two adjacent tags like
    //
    //     var x = <div>one</div><div>two</div>;
    //
    // the default error message is a bit incomprehensible. Since it's
    // rarely (never?) useful to write a less-than sign after an XJS
    // element, we disallow it here in the parser in order to provide a
    // better error message. (In the rare case that the less-than operator
    // was intended, the left tag can be wrapped in parentheses.)
    if (!origInXJSChild && tokType === _lt) {
      raise(tokStart, "Adjacent XJS elements must be wrapped in an enclosing tag");
    }

    node.openingElement = openingElement;
    node.closingElement = closingElement;
    node.children = children;
    return finishNode(node, "XJSElement");
  }

  // Declare
  
  function parseDeclareClass(node) {
    next();
    parseInterfaceish(node, true);
    return finishNode(node, "DeclareClass");
  }

  function parseDeclareFunction(node) {
    next();

    var id = node.id = parseIdent();

    var typeNode = startNode();
    var typeContainer = startNode();

    if (tokType === _lt) {
      typeNode.typeParameters = parseTypeParameterDeclaration();
    } else {
      typeNode.typeParameters = null;
    }

    expect(_parenL);
    var tmp = parseFunctionTypeParams();
    typeNode.params = tmp.params;
    typeNode.rest = tmp.rest;
    expect(_parenR);

    expect(_colon);
    typeNode.returnType = parseType();

    typeContainer.typeAnnotation = finishNode(typeNode, "FunctionTypeAnnotation");
    id.typeAnnotation = finishNode(typeContainer, "TypeAnnotation");

    finishNode(id, id.type);

    semicolon();

    return finishNode(node, "DeclareFunction");
  }

  function parseDeclare(node) {
    if (tokType === _class) {
      return parseDeclareClass(node);
    } else if (tokType === _function) {
      return parseDeclareFunction(node);
    } else if (tokType === _var) {
      return parseDeclareVariable(node);
    } else if (tokType === _name && tokVal === "module") {
      return parseDeclareModule(node);
    } else {
      unexpected();
    }
  }

  function parseDeclareVariable(node) {
    next();
    node.id = parseTypeAnnotatableIdentifier();
    semicolon();
    return finishNode(node, "DeclareVariable");
  }

  function parseDeclareModule(node) {
    next();

    if (tokType === _string) {
      node.id = parseExprAtom();
    } else {
      node.id = parseIdent();
    }

    var bodyNode = node.body = startNode();
    var body = bodyNode.body = [];
    expect(_braceL);
    while (tokType !== _braceR) {
      var node2 = startNode();

      // todo: declare check
      next();

      body.push(parseDeclare(node2));
    }
    expect(_braceR);

    finishNode(bodyNode, "BlockStatement");
    return finishNode(node, "DeclareModule");
  }


  // Interfaces

  function parseInterfaceish(node, allowStatic) {
    node.id = parseIdent();
    if (tokType === _lt) {
      node.typeParameters = parseTypeParameterDeclaration();
    } else {
      node.typeParameters = null;
    }

    node.extends = [];

    if (eat(_extends)) {
      do {
        node.extends.push(parseInterfaceExtends());
      } while(eat(_comma));
    }

    node.body = parseObjectType(allowStatic);
  }

  function parseInterfaceExtends() {
    var node = startNode();

    node.id = parseIdent();
    if (tokType === _lt) {
      node.typeParameters = parseTypeParameterInstantiation();
    } else {
      node.typeParameters = null;
    }

    return finishNode(node, "InterfaceExtends");
  }

  function parseInterface(node) {
    parseInterfaceish(node, false);
    return finishNode(node, "InterfaceDeclaration");
  }

  // Type aliases
  
  function parseTypeAlias(node) {
    node.id = parseIdent();

    if (tokType === _lt) {
      node.typeParameters = parseTypeParameterDeclaration();
    } else {
      node.typeParameters = null;
    }

    expect(_eq);

    node.right = parseType();

    semicolon();

    return finishNode(node, "TypeAlias");
  }

  // Type annotations

  function parseTypeParameterDeclaration() {
    var node = startNode();
    node.params = [];

    expect(_lt);
    while (tokType !== _gt) {
      node.params.push(parseIdent());
      if (tokType !== _gt) {
        expect(_comma);
      }
    }
    expect(_gt);

    return finishNode(node, "TypeParameterDeclaration");
  }

  function parseTypeParameterInstantiation() {
    var node = startNode(), oldInType = inType;
    node.params = [];

    inType = true;

    expect(_lt);
    while (tokType !== _gt) {
      node.params.push(parseType());
      if (tokType !== _gt) {
        expect(_comma);
      }
    }
    expect(_gt);

    inType = oldInType;

    return finishNode(node, "TypeParameterInstantiation");
  }

  function parseObjectPropertyKey() {
    return (tokType === _num || tokType === _string) ? parseExprAtom() : parseIdent(true);;
  }

  function parseObjectTypeIndexer(node, isStatic) {
    node.static = isStatic;

    expect(_bracketL);
    node.id = parseObjectPropertyKey();
    expect(_colon);
    node.key = parseType();
    expect(_bracketR);
    expect(_colon);
    node.value = parseType();

    return finishNode(node, "ObjectTypeIndexer");
  }

  function parseObjectTypeMethodish(node) {
    node.params = [];
    node.rest = null;
    node.typeParameters = null;

    if (tokType === _lt) {
      node.typeParameters = parseTypeParameterDeclaration();
    }

    expect(_parenL);
    while (tokType === _name) {
      node.params.push(parseFunctionTypeParam());
      if (tokType !== _parenR) {
        expect(_comma);
      }
    }

    if (eat(_ellipsis)) {
      node.rest = parseFunctionTypeParam();
    }
    expect(_parenR);
    expect(_colon);
    node.returnType = parseType();

    return finishNode(node, "FunctionTypeAnnotation");
  }

  function parseObjectTypeMethod(start, isStatic, key) {
    var node = startNodeAt(start);
    node.value = parseObjectTypeMethodish(startNodeAt(start));
    node.static = isStatic;
    node.key = key;
    node.optional = false;
    return finishNode(node, "ObjectTypeProperty");
  }

  function parseObjectTypeCallProperty(node, isStatic) {
    var valueNode = startNode();
    node.static = isStatic;
    node.value = parseObjectTypeMethodish(valueNode);
    return finishNode(node, "ObjectTypeCallProperty");
  }

  function parseObjectType(allowStatic) {
    var nodeStart = startNode();
    var node;
    var optional = false;
    var property;
    var propertyKey;
    var propertyTypeAnnotation;
    var token;
    var isStatic;

    nodeStart.callProperties = [];
    nodeStart.properties = [];
    nodeStart.indexers = [];

    expect(_braceL);

    while (tokType !== _braceR) {
      var start = storeCurrentPos();
      node = startNode();
      if (allowStatic && tokType === _name && tokVal === "static") {
        next();
        isStatic = true;
      }

      if (tokType === _bracketL) {
        nodeStart.indexers.push(parseObjectTypeIndexer(node, isStatic));
      } else if (tokType === _parenL || tokType === _lt) {
        nodeStart.callProperties.push(parseObjectTypeCallProperty(node, allowStatic));
      } else {
        if (isStatic && tokType === _colon) {
          propertyKey = parseIdent();
        } else {
          propertyKey = parseObjectPropertyKey();
        }
        if (tokType === _lt || tokType === _parenL) {
          // This is a method property
          nodeStart.properties.push(parseObjectTypeMethod(start, isStatic, propertyKey));
        } else {
          if (eat(_question)) {
            optional = true;
          }
          expect(_colon);
          node.key = propertyKey;
          node.value = parseType();
          node.optional = optional;
          node.static = isStatic;
          nodeStart.properties.push(finishNode(node, "ObjectTypeProperty"));
        }
      }

      if (!eat(_semi) && tokType !== _braceR) {
        unexpected();
      }
    }

    expect(_braceR);

    return finishNode(nodeStart, "ObjectTypeAnnotation")
  }

  function parseGenericType(start, id) {
    var node = startNodeAt(start);

    node.typeParameters = null;
    node.id = id;

    while (eat(_dot)) {
      var node2 = startNodeAt(start);
      node2.qualification = node.id;
      node2.id = parseIdent();
      node.id = finishNode(node2, "QualifiedTypeIdentifier");
    }

    if (tokType === _lt) {
      node.typeParameters = parseTypeParameterInstantiation();
    }

    return finishNode(node, "GenericTypeAnnotation");
  }

  function parseVoidType() {
    var node = startNode();
    expect(keywordTypes["void"]);
    return finishNode(node, "VoidTypeAnnotation");
  }

  function parseTypeofType() {
    var node = startNode();
    expect(keywordTypes["typeof"]);
    node.argument = parsePrimaryType();
    return finishNode(node, "TypeofTypeAnnotation");
  }

  function parseTupleType() {
    var node = startNode();
    node.types = [];
    expect(_bracketL);
    // We allow trailing commas
    while (tokPos < inputLen && tokType !== _bracketR) {
      node.types.push(parseType());
      if (tokType === _bracketR) break;
      expect(_comma);
    }
    expect(_bracketR);
    return finishNode(node, "TupleTypeAnnotation");
  }

  function parseFunctionTypeParam() {
    var optional = false;
    var node = startNode();
    node.name = parseIdent();
    if (eat(_question)) {
      optional = true;
    }
    expect(_colon);
    node.optional = optional;
    node.typeAnnotation = parseType();
    return finishNode(node, "FunctionTypeParam");
  }

  function parseFunctionTypeParams() {
    var ret = { params: [], rest: null };
    while (tokType === _name) {
      ret.params.push(parseFunctionTypeParam());
      if (tokType !== _parenR) {
        expect(_comma);
      }
    }

    if (eat(_ellipsis)) {
      ret.rest = parseFunctionTypeParam();
    }
    return ret;
  }

  function identToTypeAnnotation(start, node, id) {
    switch (id.name) {
      case 'any':
        return finishNode(node, "AnyTypeAnnotation");

      case 'bool':
      case 'boolean':
        return finishNode(node, "BooleanTypeAnnotation");

      case 'number':
        return finishNode(node, "NumberTypeAnnotation");

      case 'string':
        return finishNode(node, "StringTypeAnnotation");

      default:
        return parseGenericType(start, id);
    }
  }

  // The parsing of types roughly parallels the parsing of expressions, and
  // primary types are kind of like primary expressions...they're the
  // primitives with which other types are constructed.
  function parsePrimaryType() {
    var typeIdentifier = null;
    var params = null;
    var returnType = null;
    var start = storeCurrentPos();
    var node = startNode();
    var rest = null;
    var tmp;
    var typeParameters;
    var token;
    var type;
    var isGroupedType = false;

    switch (tokType) {
      case _name:
        return identToTypeAnnotation(start, node, parseIdent());

      case _braceL:
        return parseObjectType();

      case _bracketL:
        return parseTupleType();

      case _lt:
        node.typeParameters = parseTypeParameterDeclaration();
        expect(_parenL);
        tmp = parseFunctionTypeParams();
        node.params = tmp.params;
        node.rest = tmp.rest;
        expect(_parenR);

        expect(_arrow);

        node.returnType = parseType();

        return finishNode(node, "FunctionTypeAnnotation");

      case _parenL:
        next();

        var tmpId;

        // Check to see if this is actually a grouped type
        if (tokType !== _parenR && tokType !== _ellipsis) {
          if (tokType === _name) {
            //tmpId = identToTypeAnnotation(start, node, parseIdent());
            //next();
            //isGroupedType = tokType !== _question && tokType !== _colon;
          } else {
            isGroupedType = true;
          }
        }

        if (isGroupedType) {
          if (tmpId && _parenR) {
            type = tmpId;
          } else {
            type = parseType();
            expect(_parenR);
          }

          // If we see a => next then someone was probably confused about
          // function types, so we can provide a better error message
          if (eat(_arrow)) {
            raise(node,
              'Unexpected token =>. It looks like ' +
              'you are trying to write a function type, but you ended up ' +
              'writing a grouped type followed by an =>, which is a syntax ' +
              'error. Remember, function type parameters are named so function ' +
              'types look like (name1: type1, name2: type2) => returnType. You ' +
              'probably wrote (type1) => returnType'
            );
          }

          return type;
        }

        tmp = parseFunctionTypeParams();
        node.params = tmp.params;
        node.rest = tmp.rest;

        expect(_parenR);

        expect(_arrow);

        node.returnType = parseType();
        node.typeParameters = null;

        return finishNode(node, "FunctionTypeAnnotation");

      case _string:
        node.value = tokVal;
        node.raw = input.slice(tokStart, tokEnd);
        next();
        return finishNode(node, "StringLiteralTypeAnnotation");

      default:
        if (tokType.keyword) {
          switch (tokType.keyword) {
            case 'void':
              return parseVoidType();

            case 'typeof':
              return parseTypeofType();
          }
        }
    }

    unexpected();
  }

  function parsePostfixType() {
    var node = startNode();
    var type = node.elementType = parsePrimaryType();
    if (tokType === _bracketL) {
      expect(_bracketL);
      expect(_bracketR);
      return finishNode(node, "ArrayTypeAnnotation");
    }
    return type;
  }

  function parsePrefixType() {
    var node = startNode();
    if (eat(_question)) {
      node.typeAnnotation = parsePrefixType();
      return finishNode(node, "NullableTypeAnnotation");
    }
    return parsePostfixType();
  }

  function parseIntersectionType() {
    var node = startNode();
    var type = parsePrefixType();
    node.types = [type];
    while (eat(_bitwiseAND)) {
      node.types.push(parsePrefixType());
    }
    return node.types.length === 1 ? type : finishNode(node, "IntersectionTypeAnnotation");
  }

  function parseUnionType() {
    var node = startNode();
    var type = parseIntersectionType();
    node.types = [type];
    while (eat(_bitwiseOR)) {
      node.types.push(parseIntersectionType());
    }
    return node.types.length === 1 ? type : finishNode(node, "UnionTypeAnnotation");
  }

  function parseType() {
    var oldInType = inType;
    inType = true;
    var type = parseUnionType();
    inType = oldInType;
    return type;
  }

  function parseTypeAnnotation() {
    var node = startNode();

    expect(_colon);
    node.typeAnnotation = parseType();

    return finishNode(node, "TypeAnnotation");
  }

  function parseTypeAnnotatableIdentifier(requireTypeAnnotation, canBeOptionalParam) {
    var node = startNode();
    var ident = parseIdent();
    var isOptionalParam = false;

    if (canBeOptionalParam && eat(_question)) {
      expect(_question);
      isOptionalParam = true;
    }

    if (requireTypeAnnotation || tokType === _colon) {
      ident.typeAnnotation = parseTypeAnnotation();
      finishNode(ident, ident.type);
    }

    if (isOptionalParam) {
      ident.optional = true;
      finishNode(ident, ident.type);
    }

    return ident;
  }
});