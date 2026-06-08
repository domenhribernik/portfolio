---
title: Building a Blog With No Build Step
date: 2026-05-28
author: Domen Hribernik
tag: Engineering
excerpt: The whole site is hand written static files, so the blog had to be too. Here is how it reads Markdown straight from a folder with no framework, no bundler, and no database.
---

Every page on this site is written by hand. No templates, no page builder, no framework quietly stitching things together in the background. When I decided to add a blog, it had to work the same way. Drop a Markdown file in a folder, and it shows up. Nothing to compile, nothing to deploy beyond copying files.

That sounds simple until you remember the one thing a static site genuinely cannot do: read its own folders. There is no server loop willing to list a directory for me. So the design question was never *how do I parse Markdown*, it was *how does the page know which posts exist*.

## A folder and a list

The answer is almost boringly old fashioned. There is a `posts/` folder full of `.md` files, and next to them a tiny `manifest.json` that names them:

```json
[
    "blog-post-1",
    "blog-post-2",
    ...
]
```

To publish, I write a Markdown file and add its slug to that list. That is the entire workflow. The manifest is the one piece of bookkeeping a static site asks for, and I decided it was a fair price.

## The Markdown carries everything else

I did not want metadata living in two places, drifting out of sync. So the manifest only holds slugs. Every other fact about a post lives in the frontmatter at the top of its own file:

```text
---
title: Building a Blog With No Build Step
date: 2026-05-28
author: Domen Hribernik
tag: Engineering
excerpt: ...
---
```

A small parser pulls that block apart, and the rest of the file is the body. The listing page reads each file, grabs the title, date, author, and excerpt, then sorts everything newest first. The post page reads the same file and hands the body to [marked](https://marked.js.org/) to turn into HTML. 

It is the one library the page leans on, loaded from a CDN. And if it ever fails to load, the post falls back to showing the raw Markdown text. Readable either way.

## What I left out, on purpose

There is no pagination, no tags index, no comments, no search. A personal blog with a handful of entries does not need any of it, and every feature I skip is a file I never have to maintain. If the day comes that I have two hundred posts, I will happily revisit this. That day is not today.

The reward for all this restraint is that the blog has no dependencies it can outlive. As long as a browser can fetch a text file, this thing keeps working. That is the kind of software I like to build.
