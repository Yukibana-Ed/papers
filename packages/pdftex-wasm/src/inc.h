/* inc.h: pausing and resuming a run (see inc.c). Included by the engine through pdftexdir/pdftex.h. */
#ifndef INC_H
#define INC_H

extern int inc_countdown; /* main loop turns until the host is asked again */
extern int inc_paused;    /* the run left main_control at its loop head and is to go on there */
extern void inc_ask(void);
extern void incpage(int page);

/* At the head of the main loop: every INC_EVERY turns the host is asked whether the run should pause. */
#define inctick()                 \
  do {                            \
    if (--inc_countdown <= 0)     \
      inc_ask();                  \
  } while (0)
/* At the entry of main_control: whether this is a paused run going on (true once per pause). */
#define incresumed() (inc_paused ? (inc_paused = 0, 1) : 0)

#endif
