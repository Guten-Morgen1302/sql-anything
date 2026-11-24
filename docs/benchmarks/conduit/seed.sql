-- Synthetic data for benchmarking TonyMckes/conduit-realworld-example-app on a realistic scale.
-- Run AFTER the app has created its own schema (sequelize.sync). Deterministic, no randomness.
-- Result: 3,000 users, 120,000 articles, ~240,000 tag links, ~200,000 favorites, ~29,000 follows, 150,000 comments (~740k rows).
insert into "Tags"(name) select 'tag' || i from generate_series(1, 60) i;

insert into "Users"(id, email, username, bio, image, password, "createdAt", "updatedAt")
select i, 'user' || i || '@example.com', 'user' || i, 'Bio of user ' || i, 'https://example.com/u/' || i || '.png',
       'placeholder-not-a-login', now(), now() -- the benchmark only issues GET requests: these users cannot log in
from generate_series(1, 3000) i;

insert into "Articles"(id, slug, title, description, body, "createdAt", "updatedAt", "userId")
select i, 'article-' || i, 'Article ' || i, 'About article ' || i, repeat('Lorem ipsum dolor sit amet. ', 20) || i,
       timestamptz '2024-01-01' + (i || ' minutes')::interval, now(), 1 + (i * 7) % 3000
from generate_series(1, 120000) i;

insert into "TagList"("articleId", "tagName")
select i, 'tag' || (1 + (i * 3) % 60) from generate_series(1, 120000) i
union
select i, 'tag' || (1 + (i * 5 + 7) % 60) from generate_series(1, 120000) i;

insert into "Favorites"("articleId", "userId")
select distinct 1 + (i * 13) % 120000, 1 + (i * 17) % 3000 from generate_series(1, 200000) i;

insert into "Followers"("userId", "followerId")
select distinct 1 + (i * 7) % 3000, 1 + (i * 11) % 3000 from generate_series(1, 30000) i
where (1 + (i * 7) % 3000) <> (1 + (i * 11) % 3000);

insert into "Comments"(id, body, "createdAt", "updatedAt", "articleId", "userId")
select i, 'Comment ' || i, now(), now(), 1 + (i * 11) % 120000, 1 + (i * 3) % 3000 from generate_series(1, 150000) i;

analyze;
