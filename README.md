# `env-at-startup`

> Replace environment variables (e.g. `process.env.API_URL`) in frontend docker containers at "start-up" time

It's the age-old problem. The DevOps people agree: 

"Docker images should be the same for all environments; Just use environment variables for configuration."


But then, as a frontend developer, you don't write server code.
Your "environment variables" are defined at build time. The [Webpack `DefinePlugin`/`EnvironmentPlugin`](https://webpack.js.org/plugins/environment-plugin/) is ubiquitous for this use-case.
That means replacing the environment variables in the code at build time. So they are baked into the container image
and need to be configured via `--build-arg`.

This is all fine and good until these worlds collide. Most software coming out of the DevOps world
doesn't support the way we do things in the frontend world. They don't expect you to bake environment variables
into the image. And, arguably, they have a point.

So why not replace the environment variables post-build, with a little script, before the docker container starts?

This script is what `env-at-startup` is doing.

```
Usage ./env-at-startup <file>... [options]

Options:
  --help           Show this screen.
  -v --verbose     Show all replacements.
  --vars           Only replace these vars. Comma-separated list, wildcards (*) allowed.
  --ignore-other   When using --vars, all other vars are ignored (by default we error out).
  --allow-missing  Missing env vars are set to undefined (by default we error out).
  --rollback       Rollback all replacements.
  --debug          Show debug logs

Examples:
  ./env-at-startup dist/*.js --vars 'API_URL,NEXT_PUBLIC_*'
  ./env-at-startup dist/*.js --rollback

Use 'find' to access files recursively:
./env-at-startup $(find . -name "*.js")
```

## How to use

You need to add the following to your Dockerfile

### 1st Download the Script

```Dockerfile
RUN curl https://raw.githubusercontent.com/MoritzKn/env-at-startup/main/index.js -o env-at-startup \
 && chmod +x env-at-startup
```

### 2nd Run the script before start-up

If you have a `docker-entrypoint.sh` and your `docker-entrypoint.sh` ends with `exec "$@"` (this is usually the case), you can do this:

```Dockerfile
RUN apk add nodejs \
 # Delete the last line containing `exec "$@"`
 && sed -i '/exec "$@"/d' docker-entrypoint.sh \
 # Append the /env-at-startup command
 && echo './env-at-startup $(find . -name "*.js")' >> docker-entrypoint.sh \
 # Add the `exec "$@"` line again
 && echo 'exec "$@"' >> docker-entrypoint.sh
```

If you are using something like `npm run start`, you could also change your CMD like so:

```Dockerfile
CMD ["/bin/sh", "-c", "./env-at-startup $(find . -name '*.js') && npm run start"]
```

## Example

Here is a full example of a basic frontend app:

```Dockerfile
FROM node:alpine as build
WORKDIR /app

RUN curl https://raw.githubusercontent.com/MoritzKn/env-at-startup/main/index.js -o env-at-startup \
 && chmod +x env-at-startup

COPY package*.json ./
RUN npm ci

COPY src src
RUN npm run build

FROM nginx:1-alpine
EXPOSE 5000

COPY nginx.conf /etc/nginx/conf.d/default.conf
# Copy the "dist" directory (make sure to adjust this!)
COPY --from=build /app/dist/ /usr/share/nginx/html
COPY --from=build /app/env-at-startup /env-at-startup

RUN apk add nodejs \
 # Delete the last line containing `exec "$@"`
 && sed -i '/exec "$@"/d' docker-entrypoint.sh \
 # Append the /env-at-startup command
 && echo './env-at-startup $(find . -name "*.js")' >> docker-entrypoint.sh \
 # Add the `exec "$@"` line again
 && echo 'exec "$@"' >> docker-entrypoint.sh
```
