# PR 52: Company selection and deletion

Captured on 6 November 2026 from the production Vite build, in local workerd with a synthetic identity, model and Company. "Before" is `main` at `cdad2a9`. "After" is `73b950d`, reproduced with:

```sh
PDA_ACCEPTANCE_CHROMIUM="<path to Chrome>" node scripts/app-smoke.mjs --data-controls-journey --output <file>
```

[receipt.json](receipt.json) records what that run asserted. It verifies no live OAuth, model or Company.

| Surface | Before | After |
| --- | --- | --- |
| Chat composer | [before-chat.png](before-chat.png): no Company control | [after-chat.png](after-chat.png): the selection, still shown after a reload |
| Settings | [before-settings.png](before-settings.png): no data controls | [after-settings.png](after-settings.png): Your data, confirming deletion |
| A Company refuses revocation | Not applicable | [after-unrevoked.png](after-unrevoked.png), [mobile](after-unrevoked-mobile.png): what couldn't be revoked, and the three choices |

The refusal is the mock Company answering `invalid_client`, as a Company would for a token issued to an earlier `client_id`. The journey then presses **Delete anyway** and confirms the agent is erased.
