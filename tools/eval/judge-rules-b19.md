# Grading rules

The input file holds search queries (`## Q<n>: <query>`) typed into a catalog of UI/design resources for developers and designers (component libraries, section galleries, templates, tools, generators, icon sets, fonts, articles, and single components / gallery examples / docs pages inside those sites). Under each query, every numbered line (`<ref>  <result>`) is one search result: a name, a short description, a URL, and sometimes flags (`registry:N` = installable components, `pages:N` = sub-pages mapped inside it, `repo`, `llms.txt`, `skill`, `code` = a component with source code, `code needs a licence`, `kinds:` = variants of the element). The order of results is random.

Grade how well each result answers its query, as the person who typed that query into this catalog would see it:
- 2 — a good answer: it is what the query asks for. For a UI element or variant query ("accordion", "sticky header"): a component, example, docs page or gallery dedicated to that element/variant. For a query asking for a kind of resource ("X gallery", "X library", "X generator", "X inspiration", "X templates"): a resource of that kind about X. For a named resource: that resource itself (its site, official repo or official docs). For a described need: a resource that meets it.
- 1 — partly: related and could help, but not quite what was asked — e.g. much broader than the query (X is only a small part of it), much narrower (a single item when a collection or library was asked), an article/listing/announcement about the thing rather than the thing, a fork/clone/third-party wrapper for a named query, or the right kind of thing in a different technology/medium than the query names.
- 0 — not useful for this query.

Judge each result on its own; any number of results in a query (all, some, none) can get 2. Turkish queries: judge by their meaning. Use only the text in the input file.

Write the output as a JSON array covering every ref in the input, in file order: [{"ref":"1.1","grade":2,"reason":"<= 15 words"}, ...]. Make sure it is valid JSON (write it with a short script if that is easier).
