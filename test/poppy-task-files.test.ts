import { describe, expect, it } from "vitest";
import { attachmentMarker, type AttachmentInfo } from "../src/attachments";
import { TaskFiles } from "../src/poppy/task-files";
import { TaskCompanyScope } from "../src/poppy/task-scope";

const lake: AttachmentInfo = { id: "att_aaaaaaaaaaaaaaaaaaaaaa", name: "lake.jpg", type: "image/jpeg", size: 1024 };
const privatePhoto: AttachmentInfo = { ...lake, id: "att_bbbbbbbbbbbbbbbbbbbbbb", name: "private.jpg" };
const marker = attachmentMarker(lake);

describe("photos selected by the User's task", () => {
  it("selects the actual attached IDs, not every file the agent stores", () => {
    const files = TaskFiles.fromUser(`Print this at shop.example\n${marker}`, [attachmentMarker(privatePhoto), marker]);
    expect(files.includes([lake.id])).toBe(true);
    expect(files.includes([privatePhoto.id])).toBe(false);
    expect(files.includes([lake.id, privatePhoto.id])).toBe(false);
    expect(TaskFiles.none().includes([lake.id])).toBe(false);
  });

  it.each(["Print lake.jpg", "Print “lake.jpg”", "Use /photos/lake.jpg", "Imprime lake.jpg"])("resolves a User-named earlier photo: %s", task => {
    expect(TaskFiles.fromUser(task, [marker]).includes([lake.id])).toBe(true);
  });

  it.each(["Print notlake.jpg", "Print lake.jpg.old", "Print lake.jpgx", "Find my order"])("does not infer a filename selection from %s", task => {
    expect(TaskFiles.fromUser(task, [marker]).includes([lake.id])).toBe(false);
  });

  it("does not choose between different photos with the same name", () => {
    const sameName = attachmentMarker({ ...privatePhoto, name: lake.name });
    expect(TaskFiles.fromUser("Print lake.jpg", [marker, sameName]).includes([lake.id])).toBe(false);
    expect(TaskFiles.fromUser(`Print this\n${marker}`, [marker, sameName]).includes([lake.id])).toBe(true);
  });

  it.each(["Print this photo", "Print that image", "Print the photo I uploaded"])("resolves a singular follow-up to the most recent User photo: %s", task => {
    const files = TaskFiles.fromUser(task, [attachmentMarker(privatePhoto), marker, task]);
    expect(files.includes([lake.id])).toBe(true);
    expect(files.includes([privatePhoto.id])).toBe(false);
  });

  it("resolves a plural follow-up to one batch, not all historical photos", () => {
    const third = { ...lake, id: "att_cccccccccccccccccccccc", name: "meadow.jpg" };
    const batch = `${marker}\n${attachmentMarker(third)}`;
    const history = [attachmentMarker(privatePhoto), batch];
    expect(TaskFiles.fromUser("Print these photos", history).includes([lake.id, third.id])).toBe(true);
    expect(TaskFiles.fromUser("Print these photos", history).includes([privatePhoto.id])).toBe(false);
    expect(TaskFiles.fromUser("Print that photo", history).includes([lake.id])).toBe(false);
  });

  it("does not use attachment metadata as a reference to another saved file", () => {
    const copy = { ...lake, name: "copy of private.jpg" };
    const task = `Print this photo at shop.example\n${attachmentMarker(copy)}`;
    const files = TaskFiles.fromUser(task, [attachmentMarker(privatePhoto), task]);
    expect(files.includes([lake.id])).toBe(true);
    expect(files.includes([privatePhoto.id])).toBe(false);
  });

  it("does not treat a filename containing a photo reference as selecting a different recent photo", () => {
    const named = attachmentMarker({ ...lake, name: "this photo.jpg" });
    const files = TaskFiles.fromUser("Print this photo.jpg", [named, attachmentMarker(privatePhoto)]);
    expect(files.includes([lake.id])).toBe(true);
    expect(files.includes([privatePhoto.id])).toBe(false);
  });

  it("freezes a selection before a later task replaces it", () => {
    const history = [marker];
    const first = TaskFiles.fromUser(marker, history);
    history.push(attachmentMarker(privatePhoto));
    const next = TaskFiles.fromUser("Find my order", history);
    expect(first.includes([lake.id])).toBe(true);
    expect(first.includes([privatePhoto.id])).toBe(false);
    expect(next.includes([lake.id])).toBe(false);
  });
});

describe("task recipient selection", () => {
  it("constrains the first model call to an explicit recipient, not just calls after Company content", () => {
    const scope = new TaskCompanyScope();
    scope.update("Print this photo at first.example", false);
    expect(scope.allow("second.example")).toBe(false);
    expect(scope.allow("first.example")).toBe(true);
  });

  it("does not turn a filename repeated in the User's narrative into a second recipient", () => {
    const scope = new TaskCompanyScope();
    scope.update("Print at first.example. The photo is copy of second.example.", false, "task", ["copy of second.example"]);
    expect(scope.allow("second.example")).toBe(false);
    expect(scope.allow("first.example")).toBe(true);
    const explicit = new TaskCompanyScope();
    explicit.update("Print this at https://second.example/prints", false, "new-task", ["second.example"]);
    expect(explicit.allow("second.example")).toBe(true);
    expect(explicit.allow("third.example")).toBe(false);
  });

  it.each(["https://first.example/orders?return_to=second.example", "first.example/orders?return_to=second.example", "first.example\\\\second.example", "[prints](https://first.example.)"])("takes only the host from %s even before the first contact", locator => {
    const scope = new TaskCompanyScope();
    scope.update(`Print this photo at ${locator}. Email ada@second.example.`, false);
    expect(scope.allow("second.example")).toBe(false);
    expect(scope.allow("first.example")).toBe(true);
  });

  it.each(["https://first.example:8443", "first.example:8443/orders"])("keeps a non-default destination port in %s", locator => {
    const scope = new TaskCompanyScope();
    scope.update(`Print at ${locator}`, false);
    expect(scope.allow("first.example")).toBe(false);
    expect(scope.allow("first.example:8444")).toBe(false);
    expect(scope.allow("first.example:8443")).toBe(true);
  });

  it("does not read an email URL's query as a Company recipient", () => {
    const scope = new TaskCompanyScope();
    scope.update("Print at first.example. Email ada@second.example?subject=prints.", false);
    expect(scope.allow("second.example")).toBe(false);
    expect(scope.allow("first.example")).toBe(true);
  });

  it("keeps one inferred first Company when the User names a brand rather than a literal hostname", () => {
    const scope = new TaskCompanyScope();
    scope.update("Print this photo with Poppy", false);
    expect(scope.allow("first.example")).toBe(true);
    expect(scope.allow("second.example")).toBe(false);
  });
});
