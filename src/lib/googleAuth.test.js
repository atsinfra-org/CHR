import { describe, expect, it } from "vitest";
import { hasReturnError, withoutReturnError } from "./googleAuth";

const SITE = "https://colonelhorseriding.com";

describe("hasReturnError", () => {
  it("sees a failure reported in the query string", () => {
    expect(hasReturnError(`${SITE}/account?error=access_denied&error_description=User+denied+access`)).toBe(true);
  });

  it("sees a failure reported in the fragment", () => {
    expect(hasReturnError(`${SITE}/account#error=server_error&error_code=unexpected_failure`)).toBe(true);
  });

  it("is false for a successful return, a plain page and an in-page link", () => {
    expect(hasReturnError(`${SITE}/account#access_token=a.b.c&refresh_token=r&expires_in=3600&token_type=bearer`)).toBe(false);
    expect(hasReturnError(`${SITE}/account`)).toBe(false);
    expect(hasReturnError(`${SITE}/#visit`)).toBe(false);
  });

  it("is false for something that is not an address", () => {
    expect(hasReturnError("not a url")).toBe(false);
  });
});

describe("withoutReturnError", () => {
  it("drops the failure from both the query string and the fragment", () => {
    const href = `${SITE}/account?error=access_denied&error_code=x&error_description=y#error=access_denied&error_description=y`;
    expect(withoutReturnError(href)).toBe("/account");
  });

  it("keeps parameters that have nothing to do with the failure", () => {
    expect(withoutReturnError(`${SITE}/?ref=ABCD1234&error=access_denied`)).toBe("/?ref=ABCD1234");
  });

  it("leaves an ordinary in-page link alone", () => {
    expect(withoutReturnError(`${SITE}/?error=access_denied#visit`)).toBe("/#visit");
  });
});
