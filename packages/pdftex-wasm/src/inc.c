/* inc.c: pdfTeX as a WebAssembly module whose run can pause and go on.

   The main loop of the engine (main_control) asks the host, before it reads the next command, whether the run
   should pause. Nothing of the run lives on the call stack at that place, so when the host says yes the module
   returns to it, and the whole state of the run is this module's memory plus what the host keeps itself (the open
   files and their positions, the outputs). The host may copy the memory; putting a copy into a module and calling
   inc_resume makes the run go on from exactly there.

   The files of the run are in host.c. */
#define EXTERN extern
#include "pdftexd.h"
#include <setjmp.h>
#include <stdlib.h>

#define IMPORT(name) __attribute__((import_module("inc"), import_name(#name)))
#define EXPORT(name) __attribute__((export_name(#name)))
IMPORT(tick) int inc_host_tick(void);   /* nonzero: pause now */
IMPORT(page) void inc_host_page(int n); /* page n is shipped out */

#define INC_EVERY 256 /* main loop turns between two questions to the host */
int inc_countdown = 1;
int inc_paused;
static jmp_buf inc_host; /* where a pause returns to: inc_main or inc_resume */

void inc_ask(void) {
  inc_countdown = INC_EVERY;
  if (inc_host_tick()) {
    inc_paused = 1;
    longjmp(inc_host, 1);
  }
}
/* A page is out: tell the host, and ask it at the next turn of the main loop whether to pause. */
void incpage(int page) {
  inc_host_page(page);
  inc_countdown = 1;
}

extern int tex_main(int, char **);
void maincontrol(void);
void finalcleanup(void);
void closefilesandterminate(void);

/* Starts a run. Returns 1 when it paused; when the run ends, the host sees proc_exit instead. */
EXPORT(inc_main) int inc_main(int argc, char **argv) {
  if (setjmp(inc_host)) return 1;
  exit(tex_main(argc, argv));
}
/* Goes on after a pause; as inc_main. What follows main_control is the end of the engine's main body. */
EXPORT(inc_resume) int inc_resume(void) {
  if (setjmp(inc_host)) return 1;
  maincontrol();
  finalcleanup();
  closefilesandterminate();
  fflush(stdout);
  readyalready = 0;
  exit((history != 0 && history != 1) ? 1 : 0);
}
/* Ends the job where it stands, as \end does but without the document's own end code: the PDF gets its fonts,
   page tree and cross-reference table. For a copy of a paused run that the host then throws away. */
EXPORT(inc_finish) void inc_finish(void) {
  closefilesandterminate();
  fflush(NULL);
}
