import { describe, expect, it } from "vitest";
import { friendlyAuthError, isValidEmail, normalizeEmail, validateAuthForm } from "./authValidation";

describe("email validation", () => {
  it.each(["harshit@gmail.com", "test@example.com", "john.doe@example.com", "member+test@example.com", "a@b.co.in", "Harshit@Gmail.COM"])(
    "accepts %s",
    (email) => expect(isValidEmail(email)).toBe(true)
  );

  it.each(["harshit", "harshit@", "@gmail.com", "harshit@.com", "harshit@gmail", "a@b..com", "a b@c.com@d.com", ""])(
    "rejects %j",
    (email) => expect(isValidEmail(email)).toBe(false)
  );

  it("normalises case, spaces and invisible characters that ride along on paste", () => {
    expect(normalizeEmail("  Harshit@Gmail.com ")).toBe("harshit@gmail.com");
    expect(normalizeEmail("harshit​@gmail.com ")).toBe("harshit@gmail.com");
    expect(isValidEmail("harshit@gmail.com﻿")).toBe(true);
  });
});

describe("form validation", () => {
  it("login needs a valid email and a password", () => {
    expect(validateAuthForm("login", { email: "x", password: "" })).toEqual({
      email: "Please enter a valid email address.",
      password: "Please enter your password.",
    });
    expect(validateAuthForm("login", { email: "a@b.co", password: "x" })).toEqual({});
  });

  it("register needs a name, matching passwords and a minimum length", () => {
    const base = { fullName: "A", email: "a@b.co", password: "secret1", confirm: "secret1" };
    expect(validateAuthForm("register", base)).toEqual({});
    expect(validateAuthForm("register", { ...base, fullName: " " }).fullName).toBeTruthy();
    expect(validateAuthForm("register", { ...base, confirm: "other" }).confirm).toBeTruthy();
    expect(validateAuthForm("register", { ...base, password: "abc", confirm: "abc" }).password).toMatch(/at least 6/);
  });

  it("forgot password only needs an email", () => {
    expect(validateAuthForm("forgot", { email: "a@b.co" })).toEqual({});
  });
});

describe("friendly auth errors", () => {
  it("never leaks raw server text", () => {
    expect(friendlyAuthError({ message: 'Email address "harshit@gmail.com" is invalid' }, "register")).toMatch(/couldn't use that email/i);
    expect(friendlyAuthError({ message: "User already registered" }, "register")).toMatch(/already exists/);
    expect(friendlyAuthError({ message: "Invalid login credentials" })).toMatch(/couldn't sign you in/);
    expect(friendlyAuthError({ message: "email rate limit exceeded" }, "register")).toMatch(/about an hour/);
    expect(friendlyAuthError({ message: "Too many requests" }, "login")).toMatch(/wait a moment/);
    expect(friendlyAuthError({ message: "xyz db exploded" }, "register")).toBe(
      "We couldn't create your account with those details. Please check them and try again."
    );
  });
});
