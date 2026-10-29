import { resolve, relative } from "node:path";
import ts from "typescript";

export const root = resolve(import.meta.dir, "../../packages/butler-app/client/ui");
const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
export const sources = program.getSourceFiles().filter(source => source.fileName.startsWith(`${root}/src/`)
  && /\.tsx?$/.test(source.fileName)
  && !/\.(test\.[^/]+|showcase\.tsx|guidance\.tsx)$/.test(source.fileName)
  && source.fileName !== resolve(root, "src/app/api.ts"));
const calls: ts.CallExpression[] = [];
const callsByName = new Map<string, ts.CallExpression[]>();
function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
}
function visit(node: ts.Node) {
  if (ts.isCallExpression(node)) {
    calls.push(node);
    const name = calleeName(node.expression);
    if (name) {
      const named = callsByName.get(name) ?? [];
      named.push(node);
      callsByName.set(name, named);
    }
  }
  ts.forEachChild(node, visit);
}
for (const source of sources) visit(source);

const signatures = new Map<ts.CallExpression, ts.Signature | undefined>();
function signature(call: ts.CallExpression) {
  if (!signatures.has(call)) signatures.set(call, checker.getResolvedSignature(call));
  return signatures.get(call);
}
const callersByOwner = new Map<ts.Node, ts.CallExpression[]>();
function callers(owner: ts.Node): ts.CallExpression[] {
  const cached = callersByOwner.get(owner);
  if (cached) return cached;
  let name: string | undefined;
  if (ts.isFunctionDeclaration(owner)) name = owner.name?.text;
  if (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) {
    if (ts.isVariableDeclaration(owner.parent) && ts.isIdentifier(owner.parent.name)) name = owner.parent.name.text;
    else if (ts.isParameter(owner.parent) && ts.isIdentifier(owner.parent.name)) name = owner.parent.name.text;
    else if (ts.isFunctionExpression(owner)) name = owner.name?.text;
  }
  const matches = (name ? callsByName.get(name) ?? [] : [])
    .filter(call => signature(call)?.declaration === owner
      || (ts.isParameter(owner.parent) && forwardsFunction(call.expression, owner)));
  callersByOwner.set(owner, matches);
  return matches;
}

function forwardsFunction(node: ts.Node, target: ts.Node, seen = new Set<ts.Node>()): boolean {
  const decl = declaration(node);
  if (!decl || seen.has(decl)) return false;
  if (ts.isParameter(decl)) {
    if (decl.initializer === target) return true;
    const owner = decl.parent as ts.SignatureDeclaration;
    const index = owner.parameters.indexOf(decl);
    return callers(owner).some(call => call.arguments[index]
      && forwardsFunction(call.arguments[index]!, target, new Set([...seen, decl])));
  }
  return false;
}

type Bindings = Map<ts.Symbol | string, string[]>;
const symbol = (node: ts.Node) => ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
  ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
function bindingKey(node: ts.Node): ts.Symbol | string | undefined {
  return ts.isPropertyAccessExpression(node) ? `${node.getSourceFile().fileName}:${node.getText()}` : symbol(node);
}
const predicateKeys = new Map<ts.Symbol | string, string>();
function predicateKey(node: ts.Node): string | undefined {
  const key = bindingKey(node);
  if (!key) return undefined;
  if (!predicateKeys.has(key)) predicateKeys.set(key, `predicate:${predicateKeys.size}`);
  return predicateKeys.get(key);
}
function declaration(node: ts.Node): ts.Declaration | undefined {
  const found = symbol(node);
  return (found && (found.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(found) : found))?.declarations?.[0];
}
function combinations(head: string[], tail: string[]): string[] {
  return head.flatMap(prefix => tail.map(suffix => prefix + suffix));
}

// Evaluate only string structure: no UI code is executed. Unknown values become x.
// Literal unions and conditionals preserve route verbs; helper calls preserve prefixes.
function strings(node: ts.Node | undefined, env: Bindings = new Map(), depth = 0): string[] {
  if (!node || depth > 24) return ["x"];
  if (node.kind === ts.SyntaxKind.NullKeyword) return [];
  const next = (value: ts.Node | undefined, bindings = env) => strings(value, bindings, depth + 1);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return next(node.expression);
  if (ts.isConditionalExpression(node)) {
    const condition = truth(node.condition, env);
    return condition === undefined ? [...next(node.whenTrue), ...next(node.whenFalse)]
      : next(condition ? node.whenTrue : node.whenFalse);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return combinations(next(node.left), next(node.right));
  if (ts.isTemplateExpression(node)) {
    let result = [node.head.text];
    for (const span of node.templateSpans) result = combinations(result, next(span.expression).map(value => value + span.literal.text));
    return [...new Set(result)];
  }
  const type = checker.getTypeAtLocation(node);
  const present = checker.getNonNullableType(type);
  const members = present.isUnion() ? present.types : [present];
  if (members.every(member => member.flags & ts.TypeFlags.NumberLike)) {
    return members.map(member => member.isNumberLiteral() ? String(member.value) : "1");
  }
  const bound = bindingKey(node);
  if (bound && env.has(bound)) return env.get(bound)!;
  const decl = declaration(node);
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
    const values = next(decl.initializer);
    if (!values.includes("x")) return values;
  }
  if (decl && ts.isParameter(decl)) {
    const owner = decl.parent;
    const index = (owner as ts.SignatureDeclaration).parameters.indexOf(decl);
    const values = callers(owner).flatMap(call => next(call.arguments[index]));
    if (values.length) return [...new Set(values)];
  }
  if (ts.isElementAccessExpression(node)) {
    const object = declaration(node.expression);
    if (object && ts.isVariableDeclaration(object) && object.initializer && ts.isObjectLiteralExpression(object.initializer)) {
      const keys = next(node.argumentExpression);
      return object.initializer.properties.flatMap(property => {
        const key = property.name?.getText().replace(/["']/g, "");
        return ts.isPropertyAssignment(property) && (keys.includes("x") || keys.includes(key ?? ""))
          ? next(property.initializer) : [];
      });
    }
  }
  if (ts.isCallExpression(node)) {
    const target = signature(node)?.declaration;
    if (target && (ts.isArrowFunction(target) || ts.isFunctionDeclaration(target)) && target.body
      && sources.includes(target.getSourceFile())) {
      const bindings = new Map(env);
      target.parameters.forEach((parameter, index) => {
        const key = symbol(parameter.name);
        if (key) bindings.set(key, next(node.arguments[index]));
      });
      if (!ts.isBlock(target.body)) return next(target.body, bindings);
      const returns = target.body.statements.filter(ts.isReturnStatement);
      if (returns.length) return returns.flatMap(statement => next(statement.expression, bindings));
    }
  }
  if (members.every(member => member.isStringLiteral())) return members.map(member => (member as ts.StringLiteralType).value);
  return ["x"];
}

function truth(node: ts.Expression, env: Bindings): boolean | undefined {
  const key = bindingKey(node);
  const bound = key && (env.get(predicateKey(node)!) ?? env.get(key));
  if (bound?.length === 1 && ["true", "false"].includes(bound[0]!)) return bound[0] === "true";
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      const left = strings(node.left, env), right = strings(node.right, env);
      if (left.length === 1 && right.length === 1 && !left.includes("x") && !right.includes("x")) return left[0] === right[0];
    }
    if (node.operatorToken.kind === ts.SyntaxKind.InKeyword && ts.isStringLiteral(node.left)) {
      const propertyName = node.left.text;
      const type = checker.getTypeAtLocation(node.right);
      const members = type.isUnion() ? type.types : [type];
      const selected = members.filter(member => member.getProperties().every(property => {
        const values = env.get(`${node.getSourceFile().fileName}:${node.right.getText()}.${property.name}`);
        if (!values) return true;
        const value = checker.getTypeOfSymbolAtLocation(property, node.right);
        return !value.isStringLiteral() || values.includes(value.value);
      }));
      if (selected.length && selected.every(member => !!member.getProperty(propertyName))) return true;
      if (selected.length && selected.every(member => !member.getProperty(propertyName))) return false;
    }
  }
}

function methods(options: ts.Node | undefined, env: Bindings): string[] {
  if (!options) return ["GET"];
  if (ts.isConditionalExpression(options)) {
    const condition = truth(options.condition, env);
    return condition === undefined ? [...methods(options.whenTrue, env), ...methods(options.whenFalse, env)]
      : methods(condition ? options.whenTrue : options.whenFalse, env);
  }
  const node = methodArgument(options);
  return node ? strings(node, env) : ["GET"];
}

export interface Route { site: string; method: string; paths: string[] }
const siteOf = (node: ts.Node) => `${relative(root, node.getSourceFile().fileName)}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

function methodArgument(options: ts.Node | undefined): ts.Node | undefined {
  if (!options || !ts.isObjectLiteralExpression(options)) return options;
  const property = options.properties.find(prop => prop.name?.getText().replace(/["']/g, "") === "method");
  if (property && ts.isPropertyAssignment(property)) return property.initializer;
  if (property && ts.isShorthandPropertyAssignment(property)) return property.name;
}

// Expand functions that forward their parameters, preserving path/method pairs per caller.
// This includes callbacks supplied as parameter defaults, whose calls resolve to that parameter.
function expand(call: ts.CallExpression, env: Bindings = new Map(), site = siteOf(call), seen = new Set<ts.Node>()): Route[] {
  const path = call.arguments[0];
  const method = methodArgument(call.arguments[1]);
  // Split indexed discriminants and conditional predicates before evaluating either argument.
  const choices: Array<{ key: ts.Symbol | string; values: string[] }> = [];
  const inspected = new Set<ts.Node>();
  function choicesIn(node: ts.Node) {
    if (inspected.has(node)) return;
    inspected.add(node);
    if (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node)) return;
    if (ts.isObjectLiteralExpression(node)) {
      const method = methodArgument(node);
      if (method) choicesIn(method);
      return;
    }
    if (ts.isConditionalExpression(node) && ts.isIdentifier(node.condition)) {
      const condition = node.condition;
      const key = predicateKey(condition);
      if (key && !env.has(key) && truth(condition, env) === undefined) choices.push({ key, values: ["true", "false"] });
    }
    if (ts.isElementAccessExpression(node)) {
      const key = bindingKey(node.argumentExpression);
      const values = strings(node.argumentExpression, env);
      if (key && !env.has(key) && !values.includes("x")) choices.push({ key, values });
    }
    if (ts.isIdentifier(node)) {
      const decl = declaration(node);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) choicesIn(decl.initializer);
    }
    ts.forEachChild(node, choicesIn);
  }
  if (path) choicesIn(path);
  if (call.arguments[1]) choicesIn(call.arguments[1]!);
  const choice = choices[0];
  if (choice) return choice.values.flatMap(value => expand(call, new Map([...env, [choice.key, [value]]]), site, seen));
  const paths = strings(path, env);
  const verbs = methods(call.arguments[1], env);
  {
    const parameters: ts.ParameterDeclaration[] = [];
    function inspect(node: ts.Node) {
      const decl = ts.isIdentifier(node) ? declaration(node) : undefined;
      if (decl && ts.isParameter(decl) && !env.has(symbol(decl.name)!)) parameters.push(decl);
      ts.forEachChild(node, inspect);
    }
    if (path) inspect(path);
    if (method) inspect(method);
    for (const parameter of parameters) {
      const owner = parameter.parent as ts.SignatureDeclaration;
      if (seen.has(owner)) continue;
      const sites = callers(owner);
      if (!sites.length) continue;
      return sites.flatMap(caller => {
        const bindings = new Map(env);
        owner.parameters.forEach((param, index) => {
          const key = symbol(param.name);
          if (key) bindings.set(key, strings(caller.arguments[index] ?? param.initializer, env));
        });
        return expand(call, bindings, siteOf(caller), new Set([...seen, owner]));
      });
    }
  }
  return verbs.map(method => ({ site, method: method.toUpperCase(), paths: [...new Set(paths)] }));
}

export function collectRoutes() {
  const routes = calls.filter(call => {
    if (!ts.isIdentifier(call.expression)) return false;
    const decl = declaration(call.expression);
    return decl && ts.isFunctionDeclaration(decl) && decl.name?.text === "api"
      && decl.getSourceFile().fileName === resolve(root, "src/app/api.ts");
  }).flatMap(call => expand(call));
  const bySiteAndMethod = new Map<string, Route>();
  for (const route of routes) {
    const key = `${route.site} ${route.method}`;
    const prior = bySiteAndMethod.get(key);
    bySiteAndMethod.set(key, { ...route, paths: [...new Set([...(prior?.paths ?? []), ...route.paths])] });
  }
  const unique = [...bySiteAndMethod.values()];
  const unresolved = unique.filter(route => !route.paths.length || route.paths.some(path => !path.startsWith("/"))
    || !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(route.method));
  return { routes: unique.filter(route => !unresolved.includes(route)), unresolved };
}
