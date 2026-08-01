FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src

# Credentials for the shared read-only account on the PUBLIC DEMO, and only there.
#
# Baking a password into browser JavaScript is normally the bug — it is exactly what was
# just removed from the billing path. It is correct here for one reason: this account is a
# VIEWER, `requireWriteRole` refuses every mutation from a VIEWER app-wide, and the whole
# purpose of the account is that any stranger may use it. A secret everyone is invited to
# use is not a secret. Left unset (the default) the button never renders, so no other
# deployment — least of all the SaaS — can accidentally ship a login shortcut.
ARG VITE_DEMO_EMAIL=""
ARG VITE_DEMO_PASSWORD=""
ENV VITE_DEMO_EMAIL=$VITE_DEMO_EMAIL
ENV VITE_DEMO_PASSWORD=$VITE_DEMO_PASSWORD

RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
