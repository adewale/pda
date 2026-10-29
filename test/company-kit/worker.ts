/** Test-only routing. Both Company implementations keep their normal authentication handlers. */
import { MockCompany, companyIdFromHost } from "../mock-company";
import hosted, { HostedCompany, type HostedEnv } from "../hosted/company";

export { MockCompany, HostedCompany };

type KitEnv = HostedEnv & { MOCK_COMPANY: DurableObjectNamespace<MockCompany> };

export default {
  async fetch(request: Request, env: KitEnv): Promise<Response> {
    if (new URL(request.url).origin === env.COMPANY_ORIGIN) return hosted.fetch(request, env);
    const id = companyIdFromHost(new URL(request.url).hostname);
    return id ? env.MOCK_COMPANY.getByName(id).fetch(request) : new Response("Unknown local Company", { status: 404 });
  }
} satisfies ExportedHandler<KitEnv>;
