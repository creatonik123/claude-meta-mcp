# Setting up your Meta Developer App and System User token

This is the full walkthrough — from "I don't have a Meta developer account yet" to "I have a System User token in `.env` that the connector can use".

> **v0.2 scope:** the connector uses **one Meta System User token** that you (the operator) mint in your own Business Portfolio. The token is single-tenant — the same token serves every Claude session that authenticates through the connector. There is no end-user OAuth flow yet (that ships in v0.3).
>
> **System User tokens are recommended over user access tokens** because they don't expire and are designed for server-to-server use. Using a Graph API Explorer user token (with 60-day refresh) still works but is no longer the default path.

> **Note on UI labels.** The screenshots and labels below assume your Meta account is set to English. If yours is set to another language (e.g. German "Systembenutzer"), the navigation paths are equivalent — just translate the menu items.

---

## Overview

You'll do these in order:

1. Create a Meta Developer App and pick the right two **Use Cases**
2. Add the App to your Meta **Business Portfolio**
3. Create a **System User** in the Business Portfolio
4. Assign **Assets** (App, Ad Account, Page) to the System User
5. Generate the System User token
6. Drop it into the connector's `.env`

Total time: ~20 minutes if you already have a Business Portfolio, ~40 if you need to create one.

---

## 1. Create a Meta Developer App

1. Go to <https://developers.facebook.com/apps>.
2. Click **Create app**.
3. Give it a name (e.g. `claude-meta-mcp`) and a contact email. Skip the optional Business Portfolio assignment for now — we'll attach it in step 2.
4. After creation you land on the App dashboard.

## 2. Pick the Use Cases

Meta replaced the old "select permissions individually" flow with a **Use Case wizard** in 2024–2025. The "Other" option is being deprecated. To unlock the full v0.3 toolset (Ads CRUD + Instagram publishing + Pages), pick **four use cases**:

In **Use cases → Add use case**:

| ✓ | Use Case | What it provides |
|---|---|---|
| ✅ | **Measure ad performance with Marketing API** | `ads_read`, `business_management`, `read_insights` |
| ✅ | **Create and manage ads with Marketing API** | `ads_management`, `business_management` |
| ✅ | **Manage everything on your Page** | `pages_show_list`, `pages_manage_posts`, `pages_manage_metadata`, `pages_read_engagement` |
| ✅ | **Manage messaging and content on Instagram** | `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights` |

Together these cover all v0.3 tools (~38 tools total).

> **`instagram_manage_messages` (DM access)** is intentionally NOT enabled here. Even for own accounts Meta requires App Review for that scope. If you need DM tools later, submit for App Review separately — the connector currently doesn't expose any DM tool.

After selecting these use cases, the App's **Permissions and Features** tab will show every permission as **"Standard Access" (granted by default)** for own assets. You don't need to submit anything for App Review for a self-hosted single-tenant deployment with your own ad accounts and IG Business accounts.

## 3. Attach the App to a Business Portfolio

This is the step most people miss. Without it, System User tokens fail with `"could not be decrypted"`.

In the Meta Developer dashboard:

1. **App settings → Basic**
2. Scroll to **Business Portfolio** at the bottom
3. Pick your existing portfolio, or **Create new** if you don't have one yet
4. **Save changes** at the bottom of the page

Verify in <https://business.facebook.com> → **Settings ⚙️ → Accounts → Apps**: your app should now appear in the list.

## 4. Create a System User

In <https://business.facebook.com>:

1. **Settings ⚙️** (bottom left) → **Users → System Users**
2. **Add** → name e.g. `claude-mcp` → role: **Admin** (System Admin)
3. Click on the new System User to open its details panel.

## 5. Assign assets to the System User

The System User needs explicit access to: **the App** (so it can mint tokens for it), **the Ad Account** (for Ads tools), and **the Page** (for Pages tools).

In the System User detail panel, click **Add Assets** for each:

### Apps
- Tab **Apps** → check `claude-meta-mcp` → role: **Develop app** or **Manage app**

### Ad Accounts
- Tab **Ad Accounts** → check your ad account
- Permissions: ✅ **Manage campaigns** + ✅ **View performance**

> If your ad account isn't listed here, first add it under **Settings → Accounts → Ad Accounts → Add**.

### Pages
- Tab **Pages** → check the Page you want the connector to manage
- Permissions: ✅ **Create content** + ✅ **Manage Page posts** + ✅ **View Page insights**

> If your Page isn't listed, first add it under **Settings → Accounts → Pages → Add**. You must be a Page admin.

## 6. Generate the System User token

Still in the System User detail panel:

1. Tab **Tokens** → **Generate New Token**
2. **Select App**: pick `claude-meta-mcp` (this binds the token's signing keys to your app)
3. **Token expiration**: choose **Never** — this is the whole point of a System User token
4. **Permissions** — check all of these (full v0.3 toolset):
   - `ads_read`
   - `ads_management`
   - `business_management`
   - `pages_show_list`
   - `pages_manage_posts`
   - `pages_manage_metadata`
   - `pages_read_engagement`
   - `instagram_basic`
   - `instagram_content_publish`
   - `instagram_manage_comments`
   - `instagram_manage_insights`
   - *(optional but harmless: `read_insights`)*

   If you only want a subset of the toolset, you can omit scopes — the matching tools will then return 403 at runtime. Examples:
   - Read-only Ads: only `ads_read` + `business_management` (no Ads CRUD, no IG, no Pages writes)
   - Pages-only: drop the `ads_*` and `instagram_*` scopes
5. **Generate Token** → the token appears once. Click the **Copy** button (do **not** select-and-copy the displayed string — Meta obfuscates it visually until you click the button).

## 7. Validate the token

Before pasting it into `.env`, sanity-check it with Meta's own debugger:

<https://developers.facebook.com/tools/debug/accesstoken/>

Paste the token. You should see:
- **Type:** System User
- **App ID:** (your app's ID)
- **Expires:** Never
- **Scopes:** the 6+ permissions you selected
- **Granular Scopes:** same list

If you instead see **"The access token could not be decrypted"**, one of these is the cause:
- The App is not assigned to the Business Portfolio (see step 3)
- The wrong App was picked from the dropdown when generating the token (see step 6.2)
- The App Secret was reset between System User creation and token generation — just regenerate the token

## 8. Drop the token into `.env`

```bash
# on the server, NOT through any third party:
nano /var/www/connector/.env
# set the line:
META_ACCESS_TOKEN=EAA...

# reload the service
pm2 reload claude-meta-mcp --update-env
# or
systemctl restart claude-meta-mcp
```

Quick confirmation:

```bash
TOKEN=$(grep ^META_ACCESS_TOKEN /var/www/connector/.env | cut -d= -f2-)
curl -s "https://graph.facebook.com/v22.0/me?access_token=$TOKEN" | jq
# → {"name":"<your system user name>","id":"..."}

curl -s "https://graph.facebook.com/v22.0/me/adaccounts?fields=id,name&access_token=$TOKEN" | jq
# → list of ad accounts you assigned

curl -s "https://graph.facebook.com/v22.0/me/accounts?fields=id,name&access_token=$TOKEN" | jq
# → list of Pages you assigned
```

## 9. Token rotation

System User tokens with "Never" expiry don't expire automatically. You should still rotate periodically:

```bash
# 1. In business.facebook.com → System Users → Tokens → Revoke Token
# 2. Generate a new one with the same scopes (step 6 above)
# 3. Update .env on the server
# 4. pm2 reload claude-meta-mcp --update-env
```

If you suspect a token leak, **revoke first**, then mint a new one — revoking takes effect immediately.

---

## Troubleshooting

**`(#100) Tried accessing nonexisting field`** — your app does not have the requested permission. Check the use cases in step 2 are both attached, and the System User has the asset assignment in step 5.

**`Invalid OAuth access token signature`** — token from a different app or a different Business Portfolio. Regenerate via step 6 with the right App selected in the dropdown.

**`(#10) Application does not have permission for this action`** — the asset (Page or Ad Account) isn't assigned to the System User, or the System User's role on the asset doesn't include the action you're trying to perform. Re-check step 5.

**`Error validating access token: Session has expired`** — only happens with user access tokens, not System User tokens. If you still see this, you generated a *user token* (e.g. via Graph API Explorer) instead of a System User token — go back to step 6.

**`The access token could not be decrypted`** — see step 7 troubleshooting list. Almost always a Business Portfolio / App-assignment issue.

---

## Standard Access vs Advanced Access

By default your app is in **Development Mode** with **Standard Access**:

- ✅ Works with your own ad accounts and Pages
- ✅ Works with up to ~5 explicitly-added test users
- ❌ Does NOT work for arbitrary public users

This is exactly right for a self-hosted single-tenant deployment.

If you ever want to offer this connector to other users (multi-tenant), you would need **Advanced Access** for several permissions, which requires:

- A **business verification** (Meta will ask for incorporation papers, address proof, etc.)
- An **App Review** submission with a screencast demonstrating each permission's use case
- A privacy policy URL and terms-of-service URL
- A data deletion callback URL

Plan for one to several review rounds. v0.3 of `claude-meta-mcp` will ship the multi-tenant OAuth flow that makes Advanced Access useful.

## What we deliberately do *not* request

- `instagram_manage_messages` — Instagram DM access. Even for own accounts Meta requires App Review for this scope, and the connector currently exposes no DM tool. Submit for App Review separately if/when needed.
- `pages_read_user_content` — we don't moderate user-generated content (Page-side comments, mentions). Page comment moderation is not in v0.3 scope.
- `whatsapp_business_messaging`, `whatsapp_business_management` — WhatsApp Business is out of scope for the connector.
- `catalog_management` — Commerce/Catalog API is out of scope.
- `leads_retrieval` — Lead Ads retrieval is out of scope.
