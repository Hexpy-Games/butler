type ContainerFrame =
  | {
      kind: "array";
      value: unknown[];
      state: "value_or_end" | "value" | "comma";
    }
  | {
      kind: "object";
      value: Record<string, unknown>;
      state: "key_or_end" | "key" | "colon" | "value" | "comma";
      key?: string;
    };

export class IncrementalJsonParser {
  private readonly decoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  });
  private readonly stack: ContainerFrame[] = [];
  private root: unknown;
  private rootSet = false;
  private token = "";
  private mode: "normal" | "string" | "escape" | "unicode" | "number" |
    "literal" = "normal";
  private stringIsKey = false;
  private unicodeDigits = "";

  push(bytes: Buffer, final = false): void {
    const text = this.decoder.decode(bytes, { stream: !final });
    for (let index = 0; index < text.length; index += 1) {
      if (this.consume(text[index]!)) index -= 1;
    }
    if (final) this.finish();
  }

  value(): unknown {
    if (!this.rootSet || this.stack.length > 0 || this.mode !== "normal") {
      throw new SyntaxError("incomplete JSON record");
    }
    return this.root;
  }

  private consume(character: string): boolean {
    if (this.mode === "string") return this.consumeString(character);
    if (this.mode === "escape") return this.consumeEscape(character);
    if (this.mode === "unicode") return this.consumeUnicode(character);
    if (this.mode === "number") {
      if (/[0-9eE+.-]/u.test(character)) {
        this.token += character;
        return false;
      }
      const value = parseJsonNumber(this.token);
      this.mode = "normal";
      this.acceptValue(value);
      return true;
    }
    if (this.mode === "literal") {
      if (/[a-z]/u.test(character)) {
        this.token += character;
        return false;
      }
      this.finishLiteral();
      return true;
    }
    if (character === " " || character === "\t" || character === "\n" ||
      character === "\r") return false;

    const frame = this.stack.at(-1);
    if (character === "}" || character === "]") {
      this.closeContainer(character);
      return false;
    }
    if (character === ",") {
      if (!frame || frame.state !== "comma") throw new SyntaxError("unexpected comma");
      frame.state = frame.kind === "object" ? "key" : "value";
      return false;
    }
    if (character === ":") {
      if (!frame || frame.kind !== "object" || frame.state !== "colon") {
        throw new SyntaxError("unexpected colon");
      }
      frame.state = "value";
      return false;
    }
    if (character === '"') {
      this.stringIsKey = Boolean(
        frame?.kind === "object" &&
          (frame.state === "key" || frame.state === "key_or_end"),
      );
      this.assertValuePosition(this.stringIsKey);
      this.token = "";
      this.mode = "string";
      return false;
    }
    this.assertValuePosition(false);
    if (character === "{" || character === "[") {
      this.stack.push(character === "{"
        ? {
            kind: "object",
            value: Object.create(null) as Record<string, unknown>,
            state: "key_or_end",
          }
        : { kind: "array", value: [], state: "value_or_end" });
      return false;
    }
    if (character === "-" || /[0-9]/u.test(character)) {
      this.token = character;
      this.mode = "number";
      return false;
    }
    if (/[tfn]/u.test(character)) {
      this.token = character;
      this.mode = "literal";
      return false;
    }
    throw new SyntaxError("invalid JSON token");
  }

  private consumeString(character: string): boolean {
    if (character === '"') {
      this.mode = "normal";
      const frame = this.stack.at(-1);
      if (this.stringIsKey) {
        if (!frame || frame.kind !== "object") throw new SyntaxError("invalid key");
        frame.key = this.token;
        frame.state = "colon";
      } else {
        this.acceptValue(this.token);
      }
      return false;
    }
    if (character === "\\") {
      this.mode = "escape";
      return false;
    }
    if (character.charCodeAt(0) < 0x20) throw new SyntaxError("control in string");
    this.token += character;
    return false;
  }

  private consumeEscape(character: string): boolean {
    const escapes: Record<string, string> = {
      '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f",
      n: "\n", r: "\r", t: "\t",
    };
    if (character === "u") {
      this.unicodeDigits = "";
      this.mode = "unicode";
      return false;
    }
    if (!(character in escapes)) throw new SyntaxError("invalid escape");
    this.token += escapes[character];
    this.mode = "string";
    return false;
  }

  private consumeUnicode(character: string): boolean {
    if (!/[0-9a-f]/iu.test(character)) throw new SyntaxError("invalid unicode escape");
    this.unicodeDigits += character;
    if (this.unicodeDigits.length === 4) {
      this.token += String.fromCharCode(Number.parseInt(this.unicodeDigits, 16));
      this.mode = "string";
    }
    return false;
  }

  private assertValuePosition(key: boolean): void {
    const frame = this.stack.at(-1);
    if (!frame) {
      if (this.rootSet) throw new SyntaxError("multiple JSON roots");
      if (key) throw new SyntaxError("root key");
      return;
    }
    const valid = frame.kind === "object"
      ? key
        ? frame.state === "key" || frame.state === "key_or_end"
        : frame.state === "value"
      : frame.state === "value" || frame.state === "value_or_end";
    if (!valid) throw new SyntaxError("unexpected JSON value");
  }

  private acceptValue(value: unknown): void {
    const frame = this.stack.at(-1);
    if (!frame) {
      if (this.rootSet) throw new SyntaxError("multiple JSON roots");
      this.root = value;
      this.rootSet = true;
      return;
    }
    if (frame.kind === "array") frame.value.push(value);
    else {
      if (frame.key === undefined) throw new SyntaxError("missing object key");
      frame.value[frame.key] = value;
      delete frame.key;
    }
    frame.state = "comma";
  }

  private closeContainer(character: string): void {
    const frame = this.stack.pop();
    if (!frame || (character === "}" ? frame.kind !== "object" : frame.kind !== "array")) {
      throw new SyntaxError("mismatched JSON container");
    }
    const empty = frame.kind === "object"
      ? frame.state === "key_or_end"
      : frame.state === "value_or_end";
    if (!empty && frame.state !== "comma") throw new SyntaxError("incomplete container");
    this.acceptValue(frame.value);
  }

  private finishLiteral(): void {
    const literals: Record<string, unknown> = { true: true, false: false, null: null };
    if (!(this.token in literals)) throw new SyntaxError("invalid JSON literal");
    const value = literals[this.token];
    this.mode = "normal";
    this.acceptValue(value);
  }

  private finish(): void {
    if (this.mode === "number") {
      const value = parseJsonNumber(this.token);
      this.mode = "normal";
      this.acceptValue(value);
    } else if (this.mode === "literal") {
      this.finishLiteral();
    }
    this.value();
  }
}

function parseJsonNumber(token: string): number {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(token)) {
    throw new SyntaxError("invalid JSON number");
  }
  const value = Number(token);
  return value;
}
