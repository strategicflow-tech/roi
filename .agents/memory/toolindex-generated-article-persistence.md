---
name: ToolIndex generated article persistence
description: Reliability constraint for generated ToolIndex blog posts across deployments.
---

Generated ToolIndex article metadata is stored in the database, but legacy generated posts can lose their rendered HTML after a redeploy if the article body exists only on the previous runtime filesystem. Do not sitemap or retain cards for a URL unless it serves a valid article; provide a canonical redirect for legacy broken URLs.

**Why:** An auto-generated post remained in production metadata and the blog list after its body was unavailable, creating an apparent article link that returned the blog/404 page.

**How to apply:** Make the article body durable before relying on automatic publishing. Treat the sitemap as a list of 200, canonical article pages only; redirect or suppress legacy records that cannot render.