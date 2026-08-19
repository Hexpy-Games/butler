import { expect, test } from "bun:test";
import type { PrincipalAuthority } from "../../packages/butler-agent/src/agent/btcc/authority/index.ts";
import type { StewardObserverReader } from "../../packages/butler-agent/src/gateways/app/domain/sessions/steward-observer.ts";
import type { CreateAppServerOptions } from "../../packages/butler-agent/src/gateways/app/interface/server/server-types.ts";

const authority = {} as PrincipalAuthority;
const observer = {} as StewardObserverReader;

// The production ingress must reject partial authority composition.
// @ts-expect-error authority requires the matching steward observer
const _authorityOnly: CreateAppServerOptions = { authority };
// @ts-expect-error observer requires the matching authority
const _observerOnly: CreateAppServerOptions = { stewardObserver: observer };

test("production composition has one complete authority/observer ingress", () => {
  expect(authority).toBeDefined();
  expect(observer).toBeDefined();
});
