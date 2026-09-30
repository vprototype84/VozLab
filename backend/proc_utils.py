"""backend/proc_utils.py — kwargs compartidos para lanzar subprocesos sin
ventana de consola en Windows.

El backend se distribuye solo para Windows (empaquetado dentro del .exe de
Electron), pero el mismo código puede ejecutarse en otros SO durante
desarrollo, así que el flag solo se aplica si os.name == 'nt'.
"""
import os
import subprocess

NO_WINDOW_KWARGS = (
    {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
)
