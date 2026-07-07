; installer.nsh — lógica personalizada de desinstalación para TranscriptorIA.
; Mismo patrón que el proyecto hermano NarraVoz: en desinstalación silenciosa
; (actualización automática, flag /S) no se borra nada; en desinstalación
; interactiva se pregunta al usuario si quiere conservar sus voces clonadas
; o borrarlo todo (incluyendo el runtime de Python y los modelos, ~5 GB).
;
; Nota: el historial de transcripciones vive en %USERPROFILE%\Transcripciones
; (fuera de APPDATA/LOCALAPPDATA, como una carpeta de documentos del usuario)
; y este desinstalador NUNCA lo borra automáticamente.

!macro customUnInstall
  IfSilent do_keep show_prompt

  show_prompt:
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "¿Quieres conservar tus voces clonadas y configuración?$\n$\n\
      Elige 'Sí' para conservarlas (se borrará el runtime de Python y los modelos, ~5 GB, \
      pero no tus voces). Elige 'No' para borrar absolutamente todo.$\n$\n\
      Tu historial de transcripciones en la carpeta 'Transcripciones' de tu usuario \
      no se modifica en ningún caso." \
      IDYES do_keep IDNO do_wipe_all

  do_keep:
    ; Conservar $APPDATA\TranscriptorIA (voces custom); borrar solo runtime/modelos.
    RMDir /r "$LOCALAPPDATA\TranscriptorIA\runtime"
    RMDir /r "$LOCALAPPDATA\TranscriptorIA\models"
    Goto done

  do_wipe_all:
    RMDir /r "$LOCALAPPDATA\TranscriptorIA"
    RMDir /r "$APPDATA\TranscriptorIA"
    Goto done

  done:
!macroend
