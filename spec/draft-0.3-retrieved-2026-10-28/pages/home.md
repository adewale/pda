# An open protocol for every company and every personal agent.

Personal agents can discover participating companies, sign users in, and get things done through APIs, web pages, and company agents. Companies decide how to empower agents and what they can do.

[See examples](#examples)[Read the docs](/docs/introduction)

## Creating choice and control

People already hand everyday tasks to personal agents, and many of those tasks end at a company. Today it is all or nothing: the company blocks the agent, or the agent signs in as the person and can do anything they can. As agents do more, both sides waste more effort on this, with companies trying to detect agents and agents trying to avoid detection. That doesn't serve anyone, and we don't think it can last.

We think everyone is better off with more choices between those two extremes. So we built **Personal Agent Protocol**, or “Poppy” for short: a shared way for companies to decide what agents can do, and for people to decide what their agent can do for them.

1. **Blocked**No agents allowed.
2. **Search rooms**Any agent
3. **See reservations**After the user signs in
4. **Book a room**With the user's approval
5. **Full access**The agent acts as the user.

## Built for everyone

Any company can take part, whether it offers a website, APIs, an MCP server, or its own agent. Users bring the personal agent of their choice.

### Users

More done with their own agent

- **Get more done with their personal agent** at every company that supports the protocol.
- **Sign in directly and control permissions:** users sign in on the company's own page and choose what their personal agent can see and do in their account.
- **Get things done faster** when their personal agent can work with the company directly instead of clicking through its website.

### Personal agents

Faster, simpler access

- **More efficient access** through the company's APIs or a conversation with its agent, instead of navigating web pages.
- **One standard protocol** across every participating company, so each new company works the same way.
- **Sign-in support** even when the user can't share their credentials with the agent: they sign in on the company's own page.

### Companies

Insight and control

- **Start with what they have:** publish a website, APIs, or agent, and add more over time.
- **Understand customer behavior across channels,** since each session follows the user through the company's APIs, website, and agent conversations.
- **Control what agents can and can't do:** which personal agents to allow, how users sign in, and which scopes of account access agents can request.

## The building blocks

Personal Agent Protocol covers the complete interface between a personal agent and a company: how the agent finds the company, who it acts for, what it is allowed to do, and how it gets work done through APIs, web pages, or a conversation with the company's agent. A company publishes once, and any personal agent can work with it. The protocol builds on widely used open standards, so teams can implement it with libraries and tools that already exist.

### Getting connected

How a personal agent finds a company and gets access for one user.

### Discovery

A document at `/.well-known/poppy.json` identifies the organization and says how to start sessions and sign in, along with the APIs and company agent it offers.

### Standard sign-in

The user signs in on the company's own page through standard OAuth and chooses what access to grant. If the company allows it, the personal agent can also sign in for the user with the credentials the company asks for, such as an email and password.

### One session across interfaces

One session covers API calls, conversations, and web browsing. APIs and conversations use a short-lived session token, bound to a key only the personal agent holds. Signing in gives the personal agent lasting access, within the scopes the company allows for that sign-in type, until it expires or the user or the company revokes it.

### Working together

How the personal agent and the company interact once connected.

### A spectrum of interfaces

Companies choose what to offer: OpenAPI, MCP, or web pages, alongside an optional company agent. Each API keeps its own schema.

### Web page access

A personal agent can browse the company's website in the same session. The agent's browser proves which session it belongs to, and the company sets its own cookie, so it recognizes the user and applies their sign-in permissions on each page.

### Conversations

The personal agent can talk with the company for the user, or let the user talk with it directly, using text plus structured data. Both sides say whether a person or an AI is speaking, so conversations can adapt to who's participating.

### Extensions

Discovery, identity, APIs, and conversations are all open to extension. Companies and industries can build on them to add things like payments, push notifications, or interactive elements.

## Three everyday tasks

Each company chooses the interface that fits the task. Follow one task through Atlas, the user's personal agent, and see what the company exposes behind it.

Atlas finds Manzanita's company agent, asks about a return, and has the user sign in when Manzanita needs to see the order.

Thu 7:31 PM5G

A

AtlasYour personal agent

My Manzanita jacket keeps the rain out, but it's not warm enough. Can you return it?

I'll ask Manzanita about a return and whether they have something warmer.

Step 1 of 5

### Finding Manzanita

The user wants to return a jacket. Atlas reads poppy.json, a file Manzanita publishes on its website, to learn how to reach Manzanita's own agent. Both list Operations version 2 in their metadata, so Atlas can get the user's approval before an exchange.

MWhat Manzanita Supply sees

Publishes**poppy.json, version 0.3**

Returns**Handled by its company agent**

Sign-in**On Manzanita's own page**

Atlas → manzanitasupply.examplediscovery

```
GET https://manzanitasupply.example/.well-known/poppy.json

HTTP/1.1 200 OK
Content-Type: application/json

{
  "protocol_version": "0.3",
  "organization": {
    "name": "Manzanita Supply",
    "domain": "manzanitasupply.example"
  },
  "auth": {
    "issuer": "https://auth.manzanitasupply.example",
    "scopes": {
      "orders:read": "See your orders and returns",
      "orders:write": "Return or exchange items in your orders"
    }
  },
  "agent": {
    "protocols": [
      {
        "type": "poppy",
        "endpoint": "https://api.manzanitasupply.example/poppy/conversations"
      }
    ]
  },
  "extensions": {
    "operations": { "version": "2" }
  }
}
```

Manzanita → atlas.exampleclient metadata excerpt

```
// Atlas's client metadata document at https://atlas.example/agent.json
// advertises the same version of the Operations extension.
"extensions": {
  "operations": { "version": "2" }
}
```

Atlas → auth.manzanitasupply.exampleOAuth metadata

```
GET https://auth.manzanitasupply.example/.well-known/oauth-authorization-server

HTTP/1.1 200 OK
Content-Type: application/json

{
  "issuer": "https://auth.manzanitasupply.example",
  "token_endpoint": "https://auth.manzanitasupply.example/oauth/token",
  "revocation_endpoint": "https://auth.manzanitasupply.example/oauth/revoke",
  "authorization_endpoint": "https://auth.manzanitasupply.example/oauth/authorize",
  "grant_types_supported": [
    "refresh_token",
    "authorization_code"
  ],
  "scopes_supported": ["orders:read", "orders:write"],
  "protected_resources": ["https://manzanitasupply.example"]
}

// Atlas checks that issuer matches auth.issuer and that
// protected_resources includes https://manzanitasupply.example.
// authorization_code means Direct Sign-In is offered.
```

## Bring your company or personal agent onto Personal Agent Protocol

Read the docs to see what an implementation involves. It's a draft, and we're working with design partners to get it to 1.0. The path to 1.0 covers how that works and how to give feedback.

[Path to 1.0](/docs/path-to-1)[Read the docs](/docs/introduction)
