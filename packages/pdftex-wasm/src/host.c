/* host.c: the files of a program in a WebAssembly module, answered by the host.

   Everything the program learns from outside comes through the imports of module "inc" here and a few of WASI, so a
   run is a function of the host's answers. Linked into pdfTeX (with inc.c) and into the programs that run from start
   to end (with plain.c). */
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define IMPORT(name) __attribute__((import_module("inc"), import_name(#name)))
#define EXPORT(name) __attribute__((export_name(#name)))
IMPORT(open) int inc_host_open(const char *path, int flags);                              /* a descriptor, or -errno */
IMPORT(stat) int inc_host_stat(const char *path, int *kind, double *size, double *mtime); /* 0, or -errno */
IMPORT(kind) int inc_host_kind(const char *path);                                         /* 0 nothing, 1 file, 2 directory */
IMPORT(fstat) int inc_host_fstat(int fd, int *kind, double *size, double *mtime);
IMPORT(find) int inc_host_find(int format, const char *name, char *path, int size); /* length of the path, 0: not known */
IMPORT(getcwd) int inc_host_getcwd(char *buf, int size);
IMPORT(unlink) int inc_host_unlink(const char *path);
IMPORT(rename) int inc_host_rename(const char *from, const char *to);
IMPORT(mkdir) int inc_host_mkdir(const char *path);
IMPORT(readdir) int inc_host_readdir(int fd, void *buf, int count);

/* Write tracking. The build rewrites the module (dirty.mjs) so that every instruction that writes memory first
   sets the byte of its page here: one byte per 4 KiB page of a memory of at most 1 GiB. The host reads and clears
   the table; the program never reads it. It has whole pages of its own, which are not part of a run's state. */
__attribute__((aligned(4096))) unsigned char inc_dirty[1 << 18];
EXPORT(inc_mark_range) void inc_mark_range(unsigned addr, unsigned len) {
  if (!len) return;
  for (unsigned p = addr >> 12, e = (addr + len - 1) >> 12; p <= e; p++) inc_dirty[p] = 1;
}

/* Memory for the host to write the command line into. */
EXPORT(inc_alloc) void *inc_alloc(int n) { return malloc(n); }

/* For kpathsea (patches/0002): what a path is, without its size or time, and where the host has a file that the
   search paths do not lead to. */
int inc_kind(const char *path) { return inc_host_kind(path); }
char *inc_find(int format, const char *name) {
  char path[1024];
  int n = inc_host_find(format, name, path, sizeof path);
  if (n <= 0 || n >= (int)sizeof path) return NULL;
  path[n] = 0;
  return strdup(path);
}

/* The system calls the C library makes, answered by the host. */
static void fill(struct stat *st, int kind, double size, double mtime) {
  memset(st, 0, sizeof *st);
  st->st_mode = (kind == 2 ? S_IFDIR | 0755 : kind == 3 ? S_IFCHR | 0666 : S_IFREG | 0644);
  st->st_size = (off_t)size;
  st->st_nlink = 1;
  st->st_blksize = 4096;
  st->st_blocks = (st->st_size + 511) / 512;
  st->st_mtim.tv_sec = st->st_atim.tv_sec = st->st_ctim.tv_sec = (time_t)mtime;
}
int __syscall_openat(int dirfd, intptr_t path, int flags, ...) { return inc_host_open((const char *)path, flags); }
int __syscall_stat64(intptr_t path, intptr_t buf) {
  int kind;
  double size, mtime;
  int r = inc_host_stat((const char *)path, &kind, &size, &mtime);
  if (r) return r;
  fill((struct stat *)buf, kind, size, mtime);
  return 0;
}
int __syscall_lstat64(intptr_t path, intptr_t buf) { return __syscall_stat64(path, buf); }
int __syscall_newfstatat(int dirfd, intptr_t path, intptr_t buf, int flags) { return __syscall_stat64(path, buf); }
int __syscall_fstat64(int fd, intptr_t buf) {
  int kind;
  double size, mtime;
  int r = inc_host_fstat(fd, &kind, &size, &mtime);
  if (r) return r;
  fill((struct stat *)buf, kind, size, mtime);
  return 0;
}
int __syscall_faccessat(int dirfd, intptr_t path, int amode, int flags) { return inc_host_kind((const char *)path) ? 0 : -ENOENT; }
int __syscall_getcwd(intptr_t buf, size_t size) { return inc_host_getcwd((char *)buf, (int)size); }
int __syscall_unlinkat(int dirfd, intptr_t path, int flags) { return inc_host_unlink((const char *)path); }
int __syscall_renameat(int olddirfd, intptr_t oldpath, int newdirfd, intptr_t newpath) { return inc_host_rename((const char *)oldpath, (const char *)newpath); }
int __syscall_mkdirat(int dirfd, intptr_t path, int mode) { return inc_host_mkdir((const char *)path); }
int __syscall_getdents64(int fd, intptr_t dirp, size_t count) { return inc_host_readdir(fd, (void *)dirp, (int)count); }
int __syscall_ioctl(int fd, int op, ...) { return -ENOTTY; }
int __syscall_fcntl64(int fd, int cmd, ...) { return 0; }
