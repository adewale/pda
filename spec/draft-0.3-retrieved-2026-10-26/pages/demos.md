# Demos

This page includes demos of the Personal Agent Protocol built by the community. Try one to see the protocol at work, or read its source to see how to build a company or a personal agent that follows the Poppy spec.

These demos have not been officially reviewed or endorsed by the Personal Agent Protocol authors or partners, and being listed here doesn't guarantee a demo completely follows the [specification](/docs/0.3/spec). Each one runs on its own site, so check what it asks for before you sign in or share anything.

The protocol is still a draft and changes often, so a demo may lag behind the latest version and may not work with agents on newer versions of the protocol. See the official [specification](/docs/0.3/spec) for the most accurate source of truth.

Built a demo that you'd like to see here? Send it to us by [opening an issue](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/new?template=5-community-demo.yml).

## Cliffside Retail

A fictional outdoor-gear store built for testing Poppy using Atlas, a demo personal agent that runs in your browser. You can chat with Atlas on one side and watch every request it sends to the store on the other: discovery, sessions, direct and mediated sign-in, API calls, browsing pages, and conversations with the store's agent, including when it asks to talk to you directly.

If you are building your own personal agent, you can point it at [the store](https://www.cliffside-retail.com/) and follow its requests in the [protocol inspector](https://www.cliffside-retail.com/inspect).

[Talk to Atlas](https://www.cliffside-retail.com/atlas) · Version 0.2

## Poppy Demo Agent

A personal agent you sign in to with Google or GitHub. It finds companies that publish `poppy.json`, checks their setup, has you sign in on the company's own page, talks to the company's agent, calls its APIs, and asks for your approval before anything changes your account. The project also has a public [validator](https://poppydemoagent.dev/validator) for a company's discovery and OAuth metadata, and an interop harness that tests it against other projects.

[Try it](https://poppydemoagent.dev/) · [Source](https://github.com/adewale/pda) · Version 0.2

## Print with Poppy

A real photo-printing store with no cart or checkout button: your personal agent places the order. It uploads your photos, picks prints or a poster, and asks the store for a proposal. You approve the exact photos, crops, address, and price through the [Operations extension](/docs/0.3/extensions/operations), then pay on Stripe Checkout. Orders placed on the live store are really charged, printed, and shipped, so if you don't want to spend actual money, start with the [scripted demo](https://printwithpoppy.com/demo) or the [Agent Sandbox](https://sandbox.printwithpoppy.com), which simulates payment and delivery.

[Try it](https://printwithpoppy.com/) · [Source](https://github.com/spenciefy/print-with-poppy) · Version 0.2

## Poppy on Cloudflare Workers

A personal agent built on Cloudflare's Agents SDK and Workers AI, along with Northstar Outfitters, a fictional store, each running as a Cloudflare Worker. Ask about jackets, then ask to exchange an order: the agent starts a signed-out session, has you sign in on the store's own page, and walks you through confirming an exchange. The exchange is simulated, so nothing is bought or shipped.

[Try it](https://poppy-caller.roundtrip.workers.dev/) · [Source](https://github.com/irvinebroque/poppy-demo) · Version 0.1

---

Licensed under the [Apache License 2.0](https://personalagentprotocol.org/license).
