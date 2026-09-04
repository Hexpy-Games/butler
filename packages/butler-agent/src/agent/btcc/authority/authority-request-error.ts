export class AuthorityRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AuthorityRequestError";
  }
}
