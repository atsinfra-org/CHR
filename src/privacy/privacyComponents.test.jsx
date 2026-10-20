import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import NoticeBody from "./NoticeBody";
import LegalLayout, { ContactBox } from "./LegalLayout";

const html = (el) => renderToStaticMarkup(el);

describe("NoticeBody", () => {
  it("renders headings, lists and paragraphs", () => {
    const out = html(<NoticeBody body={"## Who we are\nWe run a club.\n- one\n- two"} />);
    expect(out).toContain("<h2");
    expect(out).toContain("Who we are");
    expect(out).toContain("<ul");
    expect(out.match(/<li/g)).toHaveLength(2);
    expect(out).toContain("We run a club.");
  });
  it("highlights a detail that has not been provided yet", () => {
    const out = html(<NoticeBody body={"Address: [not yet provided]."} />);
    expect(out).toContain("<mark");
    expect(out).toContain("[not yet provided]");
  });
  it("never turns text into markup", () => {
    const out = html(<NoticeBody body={'<img src=x onerror="alert(1)"> and <script>alert(2)</script>'} />);
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;img");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("ContactBox", () => {
  it("says so plainly while no contact details exist, and shows no fake ones", () => {
    const out = html(<ContactBox config={{ privacy_contact_email: null, grievance_officer_email: null }} />);
    expect(out).toContain("still being finalised");
    expect(out).not.toContain("mailto:");
    expect(html(<ContactBox config={null} />)).toContain("still being finalised");
  });
  it("shows only the details the club has supplied", () => {
    const out = html(
      <ContactBox
        config={{
          legal_entity_name: "Test Club Pvt Ltd",
          privacy_contact_email: "privacy@test.invalid",
          privacy_contact_phone: null,
          grievance_officer_name: "A. Officer",
          grievance_officer_email: "grievance@test.invalid",
          grievance_officer_phone: null,
          dpo_designation: null,
        }}
      />
    );
    expect(out).toContain("mailto:privacy@test.invalid");
    expect(out).toContain("mailto:grievance@test.invalid");
    expect(out).toContain("Test Club Pvt Ltd");
    expect(out).toContain("A. Officer");
    expect(out).not.toContain("tel:");
  });
});

describe("LegalLayout", () => {
  it("has the page title and links to the three legal pages", () => {
    const out = html(<LegalLayout title="Privacy Notice">body</LegalLayout>);
    expect(out).toContain("Privacy Notice");
    for (const href of ["/privacy", "/terms", "/account-deletion"]) expect(out).toContain(`href="${href}"`);
    expect(out).not.toContain('href="#"');
  });
});
