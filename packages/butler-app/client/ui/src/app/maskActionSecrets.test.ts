// test-category: security
import { expect, test } from "bun:test";
import { maskActionSecrets } from "./maskActionSecrets";

test("mask only credential values, preserving the exact action", () => {
  const unchanged = [
    "gh secret delete PROD_DB_PASSWORD", "kubectl delete secret prod-db", "npm token revoke 123abc",
    "git commit -m 'rotate token handling'", "secret notes/a.txt", "send Bearer sample-value",
    "token_count: 5", '{"token_count": 5}', "token-count: 5", "service_token_count: 5",
    "secret_notes: public", "password_hint: public", "mytoken: public", "authorization_status: ready",
    "TOKENIZER=value", "mysecret=value", "https://user@host/path", "notes/sk-example.txt",
  ];
  const masked = [
    ["X-Api-Key: example", "X-Api-Key: ••••"],
    ["X-Auth-Token: example", "X-Auth-Token: ••••"],
    ["curl -H 'X-Api-Key: example' https://example.com", "curl -H 'X-Api-Key: ••••' https://example.com"],
    ['curl -H "X-Auth-Token: example" https://example.com', 'curl -H "X-Auth-Token: ••••" https://example.com'],
    ['{"password": "two words", "path": "notes/a.txt"}', '{"password": ••••, "path": "notes/a.txt"}'],
    ["{'client_secret': 'example', 'name': 'report'}", "{'client_secret': ••••, 'name': 'report'}"],
    ["{password: 'example', path: 'notes/a.txt'}", "{password: ••••, path: 'notes/a.txt'}"],
    ["PGPASSWORD=example", "PGPASSWORD=••••"],
    ["MYSQL_PWD=example", "MYSQL_PWD=••••"],
    ["SERVICEAUTHSECRET=example", "SERVICEAUTHSECRET=••••"],
    ["Authorization: Bearer sample-value", "Authorization: Bearer ••••"],
    ["Authorization: Basic sample-value", "Authorization: Basic ••••"],
    ["OPENAI_API_KEY=sk-example", "OPENAI_API_KEY=••••"],
    ["GITHUB_TOKEN=ghp_example", "GITHUB_TOKEN=••••"],
    ["AWS_SECRET_ACCESS_KEY=example", "AWS_SECRET_ACCESS_KEY=••••"],
    ["client_secret=example", "client_secret=••••"],
    ["--password=example", "--password=••••"],
    ["--token example", "--token ••••"],
    ["run --verbose --token example", "run --verbose --token ••••"],
    ["--api-key=example", "--api-key=••••"],
    ["https://user:example@host/path", "https://user:••••@host/path"],
    ["sk-example", "••••"], ["ghp_example", "••••"], ["gho_example", "••••"],
    ["github_pat_example", "••••"], ["xoxb-example", "••••"], ["xoxp-example", "••••"],
    ["AKIAABCDEFGHIJKLMNOP", "••••"],
    ["run --token='two words'", "run --token=••••"],
    ['PASSWORD="two words"', "PASSWORD=••••"],
  ];
  for (const input of unchanged) expect(maskActionSecrets(input)).toBe(input);
  for (const [input, expected] of masked) expect(maskActionSecrets(input!)).toBe(expected!);
  for (const name of ["token", "secret", "password", "passwd", "pwd", "apikey", "api-key", "api_key", "accesskey", "access-key", "access_key", "privatekey", "private-key", "private_key", "clientsecret", "client-secret", "client_secret", "authorization"]) {
    for (const variant of [name, `service_${name}`, `service-${name}`]) {
      expect(maskActionSecrets(`${variant}: example`)).toBe(`${variant}: ••••`);
      expect(maskActionSecrets(`"${variant}": "example"`)).toBe(`"${variant}": ••••`);
      expect(maskActionSecrets(`${variant}_count: 5`)).toBe(`${variant}_count: 5`);
    }
  }
  for (const name of ["TOKEN", "SECRET", "PASSWORD", "PASSWD", "PWD", "API_KEY", "APIKEY", "ACCESS_KEY", "PRIVATE_KEY", "CLIENT_SECRET"]) {
    for (const variant of [name, `service_${name.toLowerCase()}_value`, `service-${name.toLowerCase().replaceAll("_", "-")}-value`]) {
      expect(maskActionSecrets(`${variant}=example`)).toBe(`${variant}=••••`);
      expect(maskActionSecrets(`--${variant} example`)).toBe(`--${variant} ••••`);
      const fieldExpected = variant === name ? "••••" : "example";
      expect(maskActionSecrets(`${variant}: example`)).toBe(`${variant}: ${fieldExpected}`);
      for (const quote of ['"', "'"]) {
        expect(maskActionSecrets(`${quote}${variant}${quote}: ${quote}example${quote}`)).toBe(`${quote}${variant}${quote}: ${variant === name ? "••••" : `${quote}example${quote}`}`);
      }
    }
  }
});
