FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
# Terms, privacy and the 404 body. Served extensionless (/terms, /privacy) by
# nginx.conf; legal.css carries the tokens they share with index.html.
COPY terms.html privacy.html unsubscribe.html 404.html legal.css /usr/share/nginx/html/
# Product tour video + poster frame.
COPY tour.mp4 poster.jpg /usr/share/nginx/html/
EXPOSE 80
