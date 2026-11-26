import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Card } from "../../src/poppy/wire";
import { PoppyCard } from "../../src/poppy-ui";
import { ProblemView, RichText, UrlValue } from "../../src/ui/rich";

/**
 * Long values and departures in the app (src/ui/rich.tsx), laid out as the
 * validator's results page lays them out (decision 55): a URL as a value
 * that breaks between its segments, and a departure as its subject, then
 * Expected and Got, then what follows.
 */
describe("rich values", () => {
  it("sets a URL in code, its host in bold, a break after each slash, and a long segment shortened with the whole in the tooltip", () => {
    const url = "https://login.example-idp.com/app/example_idp_production_tenant_1/sso/saml?…";
    const { container } = render(<UrlValue url={url} />);
    const code = container.querySelector("code")!;
    expect(code.getAttribute("title")).toBe(url);
    expect(code.innerHTML).toBe('https://<b class="font-semibold">login.example-idp.com</b>/<wbr>app/<wbr>example_idp_prod…enant_1/<wbr>sso/<wbr>saml<wbr>?<wbr>…');
    expect(code.className).toContain("[overflow-wrap:anywhere]");
  });

  it("breaks a query shown whole after each ? & and =, and leaves a short URL's tooltip off", () => {
    const { container } = render(<UrlValue url="https://a.example/x?b=1&c=2" />);
    expect(container.querySelector("code")!.innerHTML).toBe('https://<b class="font-semibold">a.example</b>/<wbr>x<wbr>?<wbr>b=<wbr>1&amp;<wbr>c=<wbr>2');
    expect(container.querySelector("code")!.hasAttribute("title")).toBe(false);
  });

  it("finds the URLs in text and leaves the words as they are", () => {
    const { container } = render(
      <p>
        <RichText text="got a page at https://a.example/x?…, on another host." />
      </p>
    );
    expect(container.textContent).toBe("got a page at https://a.example/x?…, on another host.");
    expect(container.querySelectorAll("code")).toHaveLength(1);
  });

  it("shows a departure as its subject, then Expected and Got apart, then what follows", () => {
    render(<ProblemView problem={{ subject: "its summary", expected: "at most 4000 characters", got: "4001", detail: "Nothing was done" }} />);
    const terms = screen.getAllByRole("term").map((term) => term.textContent);
    const definitions = screen.getAllByRole("definition").map((definition) => definition.textContent);
    expect(terms).toEqual(["Expected", "Got"]);
    expect(definitions).toEqual(["at most 4000 characters", "4001"]);
    expect(screen.getByText("its summary")).toBeTruthy();
    expect(screen.getByText("Nothing was done")).toBeTruthy();
  });

  it("puts a notice's departure under its sentence, on a card", () => {
    const card: Card = {
      id: "approval-unusable-x",
      kind: "notice",
      company: "Mock Shop",
      open: false,
      text: "Mock Shop asked for your approval, but its terms couldn't be used, so nothing was done.",
      problem: { subject: "its operation_id", expected: "1 to 256 URL-safe characters", got: "9 characters, some not URL-safe" }
    };
    const { container } = render(<PoppyCard card={card} send={() => true} />);
    expect(container.textContent).toContain("so nothing was done.");
    expect(screen.getAllByRole("definition").map((definition) => definition.textContent)).toEqual(["1 to 256 URL-safe characters", "9 characters, some not URL-safe"]);
  });
});
