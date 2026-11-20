#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define SOCKET_NAME "df_su_v1"
#define POLICY_PATH "/data/adb/droidforge/root_policy.conf"
#define LOG_PATH "/data/adb/droidforge/su.log"
#define DF_SU_MAGIC 0x44465355U
#define DF_SU_VERSION "27.0:DROIDFORGE-SU"
#define DF_SU_VERCODE "27000"
#define MAX_ARGC 128U
#define MAX_BODY_LEN 65536U
#define MAX_ALLOWLIST_UIDS 1024
#define MAX_LOG_BYTES 65536

#define FLAG_EXEC_DIRECT 1U

typedef struct {
    uint32_t magic;
    uint32_t target_uid;
    uint32_t target_gid;
    uint32_t flags;
    uint32_t argc;
    uint32_t body_len;
} su_header_t;

typedef enum {
    MODE_DISABLED = 0,
    MODE_ALLOW_ALL = 1,
    MODE_ALLOWLIST = 2
} policy_mode_t;

typedef struct {
    policy_mode_t mode;
    int adb_root;
    uint32_t uids[MAX_ALLOWLIST_UIDS];
    size_t uid_count;
} root_policy_t;

static void init_sockaddr(struct sockaddr_un *addr, socklen_t *len) {
    memset(addr, 0, sizeof(*addr));
    addr->sun_family = AF_UNIX;
    addr->sun_path[0] = '\0';
    memcpy(addr->sun_path + 1, SOCKET_NAME, sizeof(SOCKET_NAME) - 1);
    *len = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + (sizeof(SOCKET_NAME) - 1));
}

static int read_all(int fd, void *buf, size_t len) {
    uint8_t *p = (uint8_t *)buf;
    size_t off = 0;
    while (off < len) {
        ssize_t n = read(fd, p + off, len - off);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) return -1;
        off += (size_t)n;
    }
    return 0;
}

static int write_all(int fd, const void *buf, size_t len) {
    const uint8_t *p = (const uint8_t *)buf;
    size_t off = 0;
    while (off < len) {
        ssize_t n = write(fd, p + off, len - off);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        off += (size_t)n;
    }
    return 0;
}

static void ensure_std_fds(void) {
    for (int fd = 0; fd <= 2; fd++) {
        if (fcntl(fd, F_GETFD) < 0 && errno == EBADF) {
            int nullfd = open("/dev/null", fd == 0 ? O_RDONLY : O_WRONLY);
            if (nullfd >= 0 && nullfd != fd) {
                dup2(nullfd, fd);
                close(nullfd);
            }
        }
    }
}

static void load_policy(root_policy_t *pol) {
    memset(pol, 0, sizeof(*pol));
    pol->mode = MODE_DISABLED;
    pol->adb_root = 0;

    FILE *f = fopen(POLICY_PATH, "r");
    if (!f) return;

    char line[256];
    while (fgets(line, sizeof(line), f)) {
        size_t l = strlen(line);
        while (l > 0 && (line[l - 1] == '\n' || line[l - 1] == '\r' || line[l - 1] == ' ' || line[l - 1] == '\t')) {
            line[--l] = '\0';
        }
        char *s = line;
        while (*s == ' ' || *s == '\t') s++;
        if (*s == '\0' || *s == '#') continue;

        if (strncmp(s, "mode=", 5) == 0) {
            const char *val = s + 5;
            if (strcmp(val, "allow_all") == 0) pol->mode = MODE_ALLOW_ALL;
            else if (strcmp(val, "allowlist") == 0) pol->mode = MODE_ALLOWLIST;
            else pol->mode = MODE_DISABLED;
        } else if (strncmp(s, "adb_root=", 9) == 0) {
            pol->adb_root = (s[9] == '1') ? 1 : 0;
        } else if (strncmp(s, "uid=", 4) == 0) {
            char *end = NULL;
            unsigned long u = strtoul(s + 4, &end, 10);
            if (end != s + 4 && *end == '\0' && u <= UINT32_MAX && pol->uid_count < MAX_ALLOWLIST_UIDS) {
                pol->uids[pol->uid_count++] = (uint32_t)u;
            }
        }
    }
    fclose(f);
}

static int is_authorized(const root_policy_t *pol, uint32_t uid) {
    if (uid == 0U) return 1;
    if (pol->mode == MODE_DISABLED) return 0;
    if (uid == 2000U) {
        return (pol->adb_root == 1 || pol->mode == MODE_ALLOW_ALL) ? 1 : 0;
    }
    if (pol->mode == MODE_ALLOW_ALL) return 1;
    for (size_t i = 0; i < pol->uid_count; i++) {
        if (pol->uids[i] == uid) return 1;
    }
    return 0;
}

static void append_audit_log(uint32_t uid, int32_t pid, int allowed, const char *summary) {
    int fd = open(LOG_PATH, O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (fd < 0) return;

    struct stat st;
    if (fstat(fd, &st) == 0 && st.st_size > MAX_LOG_BYTES) {
        close(fd);
        fd = open(LOG_PATH, O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd < 0) return;
    }

    char clean[201];
    size_t j = 0;
    if (summary && summary[0]) {
        for (size_t i = 0; summary[i] && j < 200; i++) {
            unsigned char c = (unsigned char)summary[i];
            if (c == '\n' || c == '\r' || c == '\t' || c < 32) {
                clean[j++] = ' ';
            } else {
                clean[j++] = (char)c;
            }
        }
    }
    clean[j] = '\0';
    if (j == 0) strcpy(clean, "sh");

    char line[320];
    int n = snprintf(
        line,
        sizeof(line),
        "%ld %u %d %s %s\n",
        (long)time(NULL),
        uid,
        (int)pid,
        allowed ? "ALLOW" : "DENY",
        clean
    );
    if (n > 0) {
        size_t to_write = (size_t)n < sizeof(line) ? (size_t)n : sizeof(line) - 1;
        (void)write_all(fd, line, to_write);
    }
    close(fd);
}

static int recv_header_and_fds(int conn, su_header_t *hdr, int fds[3]) {
    fds[0] = fds[1] = fds[2] = -1;

    struct iovec iov;
    iov.iov_base = hdr;
    iov.iov_len = sizeof(*hdr);

    union {
        char buf[CMSG_SPACE(sizeof(int) * 3)];
        struct cmsghdr align;
    } cmsg_u;
    memset(&cmsg_u, 0, sizeof(cmsg_u));

    struct msghdr msg;
    memset(&msg, 0, sizeof(msg));
    msg.msg_iov = &iov;
    msg.msg_iovlen = 1;
    msg.msg_control = cmsg_u.buf;
    msg.msg_controllen = sizeof(cmsg_u.buf);

    ssize_t n;
    do {
        n = recvmsg(conn, &msg, 0);
    } while (n < 0 && errno == EINTR);
    if (n <= 0) return -1;

    if ((size_t)n < sizeof(*hdr)) {
        if (read_all(conn, ((uint8_t *)hdr) + n, sizeof(*hdr) - (size_t)n) < 0) return -1;
    }

    int got_fds = 0;
    for (struct cmsghdr *cm = CMSG_FIRSTHDR(&msg); cm != NULL; cm = CMSG_NXTHDR(&msg, cm)) {
        if (cm->cmsg_level == SOL_SOCKET && cm->cmsg_type == SCM_RIGHTS) {
            size_t payload_bytes = cm->cmsg_len - CMSG_LEN(0);
            size_t count = payload_bytes / sizeof(int);
            const int *src = (const int *)CMSG_DATA(cm);
            for (size_t i = 0; i < count; i++) {
                if (got_fds < 3) {
                    fds[got_fds++] = src[i];
                } else {
                    close(src[i]);
                }
            }
        }
    }

    if (got_fds != 3) {
        for (int i = 0; i < got_fds; i++) {
            if (fds[i] >= 0) close(fds[i]);
        }
        return -1;
    }
    return 0;
}

static void handle_connection(int conn) {
    su_header_t hdr;
    int fds[3] = {-1, -1, -1};
    uint8_t *body = NULL;
    char **argv_list = NULL;
    int32_t exit_code = 1;

    struct ucred cred;
    socklen_t cred_len = sizeof(cred);
    if (getsockopt(conn, SOL_SOCKET, SO_PEERCRED, &cred, &cred_len) < 0) {
        goto done;
    }

    if (recv_header_and_fds(conn, &hdr, fds) < 0) {
        goto done;
    }

    if (hdr.magic != DF_SU_MAGIC || hdr.argc > MAX_ARGC || hdr.body_len > MAX_BODY_LEN || hdr.body_len < 8U) {
        goto done;
    }

    body = (uint8_t *)malloc(hdr.body_len + 1U);
    if (!body) goto done;
    if (read_all(conn, body, hdr.body_len) < 0) goto done;
    body[hdr.body_len] = '\0';

    size_t off = 0;
    uint32_t cwd_len = 0, shell_len = 0;
    if (off + 4U > hdr.body_len) goto done;
    memcpy(&cwd_len, body + off, 4U);
    off += 4U;
    if (cwd_len > hdr.body_len - off) goto done;
    char *cwd = (char *)malloc(cwd_len + 1U);
    if (!cwd) goto done;
    memcpy(cwd, body + off, cwd_len);
    cwd[cwd_len] = '\0';
    off += cwd_len;

    if (off + 4U > hdr.body_len) { free(cwd); goto done; }
    memcpy(&shell_len, body + off, 4U);
    off += 4U;
    if (shell_len > hdr.body_len - off) { free(cwd); goto done; }
    char *shell_path = (char *)malloc(shell_len + 1U);
    if (!shell_path) { free(cwd); goto done; }
    memcpy(shell_path, body + off, shell_len);
    shell_path[shell_len] = '\0';
    off += shell_len;

    argv_list = (char **)calloc((size_t)hdr.argc + 2U, sizeof(char *));
    if (!argv_list) { free(cwd); free(shell_path); goto done; }

    for (uint32_t i = 0; i < hdr.argc; i++) {
        if (off + 4U > hdr.body_len) {
            free(cwd);
            free(shell_path);
            goto done;
        }
        uint32_t alen = 0;
        memcpy(&alen, body + off, 4U);
        off += 4U;
        if (alen > hdr.body_len - off) {
            free(cwd);
            free(shell_path);
            goto done;
        }
        char *arg = (char *)malloc(alen + 1U);
        if (!arg) {
            free(cwd);
            free(shell_path);
            goto done;
        }
        memcpy(arg, body + off, alen);
        arg[alen] = '\0';
        off += alen;
        argv_list[i] = arg;
    }

    char summary[256];
    summary[0] = '\0';
    size_t spos = 0;
    for (uint32_t i = 0; i < hdr.argc && spos + 2 < sizeof(summary); i++) {
        if (i > 0) summary[spos++] = ' ';
        size_t remain = sizeof(summary) - 1U - spos;
        size_t alen = strlen(argv_list[i]);
        if (alen > remain) alen = remain;
        memcpy(summary + spos, argv_list[i], alen);
        spos += alen;
        summary[spos] = '\0';
    }

    root_policy_t pol;
    load_policy(&pol);
    int allowed = is_authorized(&pol, (uint32_t)cred.uid);
    append_audit_log((uint32_t)cred.uid, (int32_t)cred.pid, allowed, summary);

    if (!allowed) {
        static const char denied_msg[] = "su: permission denied\n";
        (void)write_all(fds[2], denied_msg, sizeof(denied_msg) - 1U);
        exit_code = 13;
        free(cwd);
        free(shell_path);
        goto reply;
    }

    pid_t child = fork();
    if (child < 0) {
        exit_code = 1;
        free(cwd);
        free(shell_path);
        goto reply;
    }

    if (child == 0) {
        close(conn);

        int safe[3] = {-1, -1, -1};
        for (int i = 0; i < 3; i++) {
            safe[i] = fcntl(fds[i], F_DUPFD, 10);
            if (safe[i] < 0) _exit(126);
        }
        for (int i = 0; i < 3; i++) {
            close(fds[i]);
        }
        for (int i = 0; i < 3; i++) {
            if (dup2(safe[i], i) < 0) _exit(126);
            close(safe[i]);
        }

        gid_t target_g = (gid_t)hdr.target_gid;
        (void)setgroups(1, &target_g);
        if (setgid((gid_t)hdr.target_gid) < 0 || setuid((uid_t)hdr.target_uid) < 0) {
            _exit(126);
        }

        setenv("PATH", "/sbin:/system/sbin:/system/bin:/system/xbin:/vendor/bin:/product/bin", 1);
        setenv("USER", hdr.target_uid == 0U ? "root" : "shell", 1);
        setenv("HOME", "/data/local/tmp", 1);
        if (cwd[0] != '\0') {
            (void)chdir(cwd);
        }

        if ((hdr.flags & FLAG_EXEC_DIRECT) != 0U && hdr.argc > 0U) {
            execvp(argv_list[0], argv_list);
            _exit(errno == ENOENT ? 127 : 126);
        } else {
            const char *sh = shell_path[0] != '\0' ? shell_path : "/system/bin/sh";
            char **sh_argv = (char **)calloc((size_t)hdr.argc + 2U, sizeof(char *));
            if (!sh_argv) _exit(126);
            sh_argv[0] = (char *)sh;
            for (uint32_t i = 0; i < hdr.argc; i++) {
                sh_argv[i + 1U] = argv_list[i];
            }
            sh_argv[hdr.argc + 1U] = NULL;
            execv(sh, sh_argv);
            sh_argv[0] = "/bin/sh";
            execv("/bin/sh", sh_argv);
            _exit(127);
        }
    }

    for (int i = 0; i < 3; i++) {
        if (fds[i] >= 0) {
            close(fds[i]);
            fds[i] = -1;
        }
    }
    free(cwd);
    free(shell_path);

    int status = 0;
    while (waitpid(child, &status, 0) < 0) {
        if (errno != EINTR) {
            status = 1 << 8;
            break;
        }
    }
    if (WIFEXITED(status)) {
        exit_code = WEXITSTATUS(status);
    } else if (WIFSIGNALED(status)) {
        exit_code = 128 + WTERMSIG(status);
    } else {
        exit_code = 1;
    }

reply:
    (void)write_all(conn, &exit_code, sizeof(exit_code));

done:
    for (int i = 0; i < 3; i++) {
        if (fds[i] >= 0) close(fds[i]);
    }
    if (argv_list) {
        for (uint32_t i = 0; i < hdr.argc; i++) {
            free(argv_list[i]);
        }
        free(argv_list);
    }
    free(body);
    close(conn);
}

static int run_daemon(void) {
    if (getuid() != 0) {
        fprintf(stderr, "df-su: daemon must run as root\n");
        return 1;
    }

    ensure_std_fds();
    (void)setsid();
    signal(SIGPIPE, SIG_IGN);
    signal(SIGCHLD, SIG_IGN);

    int srv = socket(AF_UNIX, SOCK_STREAM, 0);
    if (srv < 0) return 1;

    struct sockaddr_un addr;
    socklen_t addr_len;
    init_sockaddr(&addr, &addr_len);

    if (bind(srv, (struct sockaddr *)&addr, addr_len) < 0) {
        int saved = errno;
        close(srv);
        if (saved == EADDRINUSE) {
            return 0;
        }
        return 1;
    }

    if (listen(srv, 64) < 0) {
        close(srv);
        return 1;
    }

    for (;;) {
        int conn = accept(srv, NULL, NULL);
        if (conn < 0) {
            if (errno == EINTR) continue;
            break;
        }
        pid_t worker = fork();
        if (worker == 0) {
            signal(SIGCHLD, SIG_DFL);
            close(srv);
            handle_connection(conn);
            _exit(0);
        }
        close(conn);
    }

    close(srv);
    return 0;
}

static int parse_uid_gid(const char *arg, uint32_t *uid_out, uint32_t *gid_out) {
    if (strcmp(arg, "root") == 0) {
        *uid_out = 0U;
        *gid_out = 0U;
        return 1;
    }
    if (strcmp(arg, "shell") == 0) {
        *uid_out = 2000U;
        *gid_out = 2000U;
        return 1;
    }
    if (!isdigit((unsigned char)arg[0])) return 0;

    char *end = NULL;
    unsigned long u = strtoul(arg, &end, 10);
    if (end == arg || u > UINT32_MAX) return 0;
    if (*end == '\0') {
        *uid_out = (uint32_t)u;
        *gid_out = (uint32_t)u;
        return 1;
    }
    if (*end == ':' && isdigit((unsigned char)end[1])) {
        char *gend = NULL;
        unsigned long g = strtoul(end + 1, &gend, 10);
        if (gend != end + 1 && *gend == '\0' && g <= UINT32_MAX) {
            *uid_out = (uint32_t)u;
            *gid_out = (uint32_t)g;
            return 1;
        }
    }
    return 0;
}

static char *join_args(int start, int argc, char **argv) {
    size_t total = 1;
    for (int i = start; i < argc; i++) {
        total += strlen(argv[i]) + 1U;
    }
    char *out = (char *)malloc(total);
    if (!out) return NULL;
    out[0] = '\0';
    for (int i = start; i < argc; i++) {
        if (i > start) strcat(out, " ");
        strcat(out, argv[i]);
    }
    return out;
}

static int run_client(int argc, char **argv) {
    uint32_t target_uid = 0U;
    uint32_t target_gid = 0U;
    uint32_t flags = 0U;
    const char *shell = "/system/bin/sh";
    char *joined_cmd = NULL;

    const char *send_argv[MAX_ARGC];
    uint32_t send_argc = 0U;

    int i = 1;
    int saw_cmd = 0;

    while (i < argc) {
        const char *a = argv[i];
        if (strcmp(a, "-v") == 0 || strcmp(a, "--version") == 0) {
            printf("%s\n", DF_SU_VERSION);
            return 0;
        }
        if (strcmp(a, "-V") == 0) {
            printf("%s\n", DF_SU_VERCODE);
            return 0;
        }
        if (strcmp(a, "-") == 0 || strcmp(a, "-l") == 0 || strcmp(a, "--login") == 0 ||
            strcmp(a, "-p") == 0 || strcmp(a, "-m") == 0 || strcmp(a, "--preserve-environment") == 0 ||
            strcmp(a, "-mm") == 0 || strcmp(a, "-M") == 0 || strcmp(a, "--mount-master") == 0) {
            i++;
            continue;
        }
        if ((strcmp(a, "-s") == 0 || strcmp(a, "--shell") == 0) && i + 1 < argc) {
            shell = argv[i + 1];
            i += 2;
            continue;
        }
        if (strcmp(a, "-c") == 0 || strcmp(a, "--command") == 0) {
            i++;
            if (i < argc) {
                joined_cmd = join_args(i, argc, argv);
                if (!joined_cmd) return 1;
                send_argv[0] = "-c";
                send_argv[1] = joined_cmd;
                send_argc = 2U;
                saw_cmd = 1;
            }
            i = argc;
            break;
        }
        if (strcmp(a, "--") == 0) {
            i++;
            break;
        }
        break;
    }

    if (!saw_cmd && i < argc) {
        if (parse_uid_gid(argv[i], &target_uid, &target_gid)) {
            i++;
        }
    }

    if (!saw_cmd && i < argc) {
        if (strcmp(argv[i], "-c") == 0 || strcmp(argv[i], "--command") == 0) {
            i++;
            if (i < argc) {
                joined_cmd = join_args(i, argc, argv);
                if (!joined_cmd) return 1;
                send_argv[0] = "-c";
                send_argv[1] = joined_cmd;
                send_argc = 2U;
            }
        } else {
            flags |= FLAG_EXEC_DIRECT;
            while (i < argc && send_argc < MAX_ARGC) {
                send_argv[send_argc++] = argv[i++];
            }
        }
    }

    ensure_std_fds();

    char cwd_buf[PATH_MAX];
    const char *cwd = getcwd(cwd_buf, sizeof(cwd_buf)) ? cwd_buf : "";
    uint32_t cwd_len = (uint32_t)strlen(cwd);
    uint32_t shell_len = (uint32_t)strlen(shell);

    size_t body_size = 4U + cwd_len + 4U + shell_len;
    for (uint32_t k = 0; k < send_argc; k++) {
        body_size += 4U + strlen(send_argv[k]);
    }
    if (body_size > MAX_BODY_LEN) {
        fprintf(stderr, "su: arguments too large\n");
        free(joined_cmd);
        return 1;
    }

    uint8_t *body = (uint8_t *)malloc(body_size);
    if (!body) {
        free(joined_cmd);
        return 1;
    }

    size_t off = 0;
    memcpy(body + off, &cwd_len, 4U); off += 4U;
    if (cwd_len > 0U) { memcpy(body + off, cwd, cwd_len); off += cwd_len; }
    memcpy(body + off, &shell_len, 4U); off += 4U;
    if (shell_len > 0U) { memcpy(body + off, shell, shell_len); off += shell_len; }
    for (uint32_t k = 0; k < send_argc; k++) {
        uint32_t alen = (uint32_t)strlen(send_argv[k]);
        memcpy(body + off, &alen, 4U); off += 4U;
        if (alen > 0U) { memcpy(body + off, send_argv[k], alen); off += alen; }
    }

    int sock = socket(AF_UNIX, SOCK_STREAM, 0);
    if (sock < 0) {
        fprintf(stderr, "su: socket failed\n");
        free(body);
        free(joined_cmd);
        return 1;
    }

    struct sockaddr_un addr;
    socklen_t addr_len;
    init_sockaddr(&addr, &addr_len);
    if (connect(sock, (struct sockaddr *)&addr, addr_len) < 0) {
        fprintf(stderr, "su: root daemon unavailable\n");
        close(sock);
        free(body);
        free(joined_cmd);
        return 1;
    }

    su_header_t hdr;
    hdr.magic = DF_SU_MAGIC;
    hdr.target_uid = target_uid;
    hdr.target_gid = target_gid;
    hdr.flags = flags;
    hdr.argc = send_argc;
    hdr.body_len = (uint32_t)body_size;

    struct iovec iov;
    iov.iov_base = &hdr;
    iov.iov_len = sizeof(hdr);

    union {
        char buf[CMSG_SPACE(sizeof(int) * 3)];
        struct cmsghdr align;
    } cmsg_u;
    memset(&cmsg_u, 0, sizeof(cmsg_u));

    struct msghdr msg;
    memset(&msg, 0, sizeof(msg));
    msg.msg_iov = &iov;
    msg.msg_iovlen = 1;
    msg.msg_control = cmsg_u.buf;
    msg.msg_controllen = sizeof(cmsg_u.buf);

    struct cmsghdr *cm = CMSG_FIRSTHDR(&msg);
    cm->cmsg_level = SOL_SOCKET;
    cm->cmsg_type = SCM_RIGHTS;
    cm->cmsg_len = CMSG_LEN(sizeof(int) * 3);
    int std_fds[3] = {0, 1, 2};
    memcpy(CMSG_DATA(cm), std_fds, sizeof(std_fds));

    ssize_t sent;
    do {
        sent = sendmsg(sock, &msg, 0);
    } while (sent < 0 && errno == EINTR);

    if (sent != (ssize_t)sizeof(hdr) || write_all(sock, body, body_size) < 0) {
        fprintf(stderr, "su: failed to send request\n");
        close(sock);
        free(body);
        free(joined_cmd);
        return 1;
    }

    free(body);
    free(joined_cmd);

    int32_t code = 1;
    if (read_all(sock, &code, sizeof(code)) < 0) {
        code = 1;
    }
    close(sock);
    return (int)code;
}

int main(int argc, char **argv) {
    if (argc >= 2 && strcmp(argv[1], "--daemon") == 0) {
        return run_daemon();
    }
    return run_client(argc, argv);
}
