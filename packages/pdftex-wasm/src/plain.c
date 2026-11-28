/* plain.c: a program that runs from start to end (BibTeX) as a module the host starts like pdfTeX. Its files are in
   host.c; its main is renamed to program_main by the build. */
#include <stdlib.h>

extern int program_main(int, char **);

/* Runs the program. Does not return: the host sees proc_exit. */
__attribute__((export_name("inc_main"))) int inc_main(int argc, char **argv) { exit(program_main(argc, argv)); }
