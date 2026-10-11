# Другу: подключение GitHub Actions к Ubuntu/Nginx

Текущий сайт: `https://moonhaze.ru`, сервер `64.188.70.161`, действующий `root /var/www/flight-test;` в `/etc/nginx/sites-enabled/moonhaze.ru` (подтверждено выводом `nginx -T`). Новый тестовый адрес: `https://dev.moonhaze.ru`. Сначала подключаем только тестовый адрес. Все команды ниже выполняет администратор сервера; GitHub получает отдельные ограниченные ключи без sudo.

## 1. Сохранить текущую версию

До изменения Nginx сохранить папку сайта и настройки:

```sh
backup_dir="/var/backups/flight-time-$(date +%Y%m%d-%H%M%S)"
sudo mkdir -m 700 "$backup_dir"
sudo cp -a /var/www/flight-test "$backup_dir/site"
sudo cp -a /etc/nginx "$backup_dir/nginx"
sudo ls -ld "$backup_dir/site" "$backup_dir/nginx"
```

Имя резервной папки содержит дату и время. В конце должны появиться две строки: `site` и `nginx`. Если любая команда сообщает об ошибке, остановиться и проверить её. Исходную папку `/var/www/flight-test/` не удалять. База и записи пользователей находятся в Supabase; копия файлов сайта их не содержит.

## 2. Установить приёмник обновлений

Загрузить папку `server-setup` из подготовленного комплекта в домашнюю папку администратора и перейти в неё. Нужны системные Python 3, OpenSSH и Nginx; дополнительных Python-пакетов нет.

```sh
cd ~/server-setup
python3 --version
id flight-deploy
```

Если пользователя ещё нет, создать:

```sh
sudo useradd --create-home --user-group --shell /bin/bash flight-deploy
```

Не добавлять `flight-deploy` в sudoers и не выдавать ему административный пароль.

```sh
sudo install -d -o root -g root -m 755 /srv/flight-time /usr/local/lib/flight-time
sudo install -d -o flight-deploy -g flight-deploy -m 755 /srv/flight-time/dev /srv/flight-time/production
sudo install -d -o flight-deploy -g flight-deploy -m 755 /srv/flight-time/dev/releases /srv/flight-time/production/releases
sudo install -o root -g root -m 644 build-deploy-site.py deploy-receiver.py seed-deployment.py /usr/local/lib/flight-time/
```

Эти Python-файлы обслуживают публикацию и не должны быть доступны для изменения пользователю `flight-deploy`. Обновлять их впоследствии может администратор вручную.

## 3. Подготовить тестовый сайт

Создать начальный выпуск из действующего сайта. Команда не меняет Nginx и исходную папку; при повторной инициализации откажется заменять существующий `current`.

```sh
sudo -u flight-deploy python3 /usr/local/lib/flight-time/seed-deployment.py --source /var/www/flight-test --environment dev
```

Если отказано в чтении исходной папки, проверить права доступа и обсудить их отдельно; не выдавать всем право записи в сайт.

В действующей DNS-зоне `moonhaze.ru` добавить **A-запись `dev` → `64.188.70.161`**. Почтовые TXT/CNAME и DNS-серверы не менять. Если уже есть конфликтующая AAAA-запись `dev`, проверить её адрес отдельно.

Если конфигурации `dev.moonhaze.ru` ещё нет:

```sh
sudo install -o root -g root -m 644 nginx-dev.conf.example /etc/nginx/sites-available/flight-time-dev
sudo ln -s /etc/nginx/sites-available/flight-time-dev /etc/nginx/sites-enabled/flight-time-dev
sudo nginx -t
sudo systemctl reload nginx
```

Перезагрузку выполнять только после успешного `nginx -t`. Если файл или ссылка уже существуют, сначала изучить их, не заменять вслепую.

Когда DNS указывает на сервер и HTTP открывается, получить отдельный сертификат для `dev.moonhaze.ru` тем же инструментом, который обслуживает основной домен. Если уже используется Certbot с Nginx:

```sh
sudo certbot --nginx -d dev.moonhaze.ru
sudo nginx -t
```

Перед продолжением проверить `https://dev.moonhaze.ru/` и `https://dev.moonhaze.ru/release.json`: сертификат должен быть действительным, в JSON — `environment: dev`. Автоматическое обновление сертификата должно быть настроено так же, как для основного сайта.

## 4. Создать два ограниченных SSH-ключа

Выполнить под обычным администратором, не под `flight-deploy`. При существовании таких файлов не перезаписывать их.

```sh
mkdir -m 700 ~/flight-time-actions-keys
ssh-keygen -t ed25519 -N '' -C flight-actions-dev -f ~/flight-time-actions-keys/dev
ssh-keygen -t ed25519 -N '' -C flight-actions-production -f ~/flight-time-actions-keys/production
sudo install -d -o root -g root -m 755 /home/flight-deploy/.ssh
sudo touch /home/flight-deploy/.ssh/authorized_keys
sudo chown root:root /home/flight-deploy/.ssh/authorized_keys
sudo chmod 644 /home/flight-deploy/.ssh/authorized_keys
```

Добавить в `authorized_keys` две строки, заменив `<ПУБЛИЧНЫЙ_КЛЮЧ>` полным содержимым соответствующего файла `.pub` (начиная с `ssh-ed25519`). Удобно через `sudo nano /home/flight-deploy/.ssh/authorized_keys`:

```text
restrict,command="/usr/bin/python3 /usr/local/lib/flight-time/deploy-receiver.py --environment dev" <ПУБЛИЧНЫЙ_КЛЮЧ_DEV>
restrict,command="/usr/bin/python3 /usr/local/lib/flight-time/deploy-receiver.py --environment production" <ПУБЛИЧНЫЙ_КЛЮЧ_PRODUCTION>
```

Здесь нельзя убирать `restrict` или `command`. Ключи принимают только команды установки/возврата выпуска своего окружения; интерактивная консоль, перенаправление портов и произвольные команды недоступны. При наличии `AllowUsers`/`AllowGroups` в SSH разрешить пользователя `flight-deploy` согласно текущей политике сервера. Не отключать firewall и не менять глобальные правила входа ради настройки.

Закрытые файлы `dev` и `production` администратор вводит **напрямую в GitHub environment secrets**, как описано в `DEPLOYMENT.md`. Их содержимое не отправлять в чат или коммит. После успешной настройки убрать временные копии закрытых ключей с сервера, сохранив при необходимости в защищённом хранилище.

Для `DEPLOY_KNOWN_HOSTS` взять настоящий публичный ключ сервера непосредственно на сервере:

```sh
sudo cat /etc/ssh/ssh_host_ed25519_key.pub
```

Если вывод начинается с `ssh-ed25519 AAAA...`, значение secret при порте 22 должно быть:

```text
64.188.70.161 ssh-ed25519 AAAA...
```

При другом порте, например 2222: `[64.188.70.161]:2222 ssh-ed25519 AAAA...`. Не копировать многоточия. Это **публичный ключ сервера**, отличный от двух клиентских ключей выше. Не получать доверенный ключ слепо через `ssh-keyscan` в самом workflow.

После настройки GitHub включить только `DEPLOY_ENABLED=true` и проверить публикацию `dev`. Рабочую публикацию оставить выключенной.

## 5. Подключить основной сайт после проверки dev

Создать начальный рабочий выпуск:

```sh
sudo -u flight-deploy python3 /usr/local/lib/flight-time/seed-deployment.py --source /var/www/flight-test --environment production
```

Найти действующий Nginx-блок для `moonhaze.ru` через `sudo nginx -T`. В нём заменить только корневую папку:

```nginx
root /srv/flight-time/production/current;
```

В серверном блоке добавить/проверить:

```nginx
open_file_cache off;
expires -1;
```

Если `root`, `alias`, `expires` или кеширование переопределены внутри `location`, адаптировать действующую конфигурацию: сайт должен читаться из `current`, HTML/JS и `release.json` не должны оставаться в старом кеше. Не заменять весь HTTPS-блок и не менять пути сертификатов. Адреса входа в Supabase и общая база остаются прежними.

```sh
sudo nginx -t
sudo systemctl reload nginx
```

Выполнить reload только после успешной проверки. Проверить `https://moonhaze.ru/` и `/release.json` с `environment: production`, затем ввод, вход и синхронизацию. Теперь можно включить `DEPLOY_PRODUCTION_ENABLED=true` в GitHub. Следующий merge владельца в `main` запустит рабочую публикацию.

## 6. Отключение и возврат

Для паузы установить соответствующую repository variable (`DEPLOY_ENABLED` или `DEPLOY_PRODUCTION_ENABLED`) в `false`. Уже идущий запуск это не останавливает: дождаться его завершения или отменить его в Actions перед ручным возвратом. Отменённый после переключения выпуск может остаться действующим, проверить `current`.

Для ручного возврата сначала посмотреть текущий идентификатор:

```sh
readlink /srv/flight-time/production/current
readlink /srv/flight-time/production/previous
```

Затем подставить последний компонент текущего пути вместо `<ТЕКУЩИЙ_ID>`:

```sh
sudo -u flight-deploy env SSH_ORIGINAL_COMMAND='rollback <ТЕКУЩИЙ_ID>' python3 /usr/local/lib/flight-time/deploy-receiver.py --environment production
```

Для тестового сайта заменить `production` на `dev`. Если после сбоя связи версия уже изменилась, сначала сверить её: приёмник откажется откатывать устаревший ID. Если сервер вообще недоступен, автоматический возврат тоже невозможен.

Чтобы полностью вернуться к старой схеме, выключить рабочие публикации, вернуть `root /var/www/flight-test/;` в том же Nginx-блоке, выполнить `nginx -t` и reload после успеха. Исходная папка сохранена. Возврат файлов сайта не откатывает записи в Supabase.

Документация: [ограничения ключей OpenSSH](https://man.openbsd.org/sshd.8#AUTHORIZED_KEYS_FILE), [Nginx root](https://nginx.org/en/docs/http/ngx_http_core_module.html#root), [Certbot для Nginx](https://certbot.eff.org/instructions?ws=nginx&os=snap).
