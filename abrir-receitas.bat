@echo off
rem Liga o servidor local do app de receitas e abre no navegador.
rem Deixe esta janela aberta enquanto usa o app; feche para desligar.
cd /d "%~dp0"
title Minha Cozinha - servidor
start "" http://localhost:8766
echo App em http://localhost:8766
echo No celular (mesmo Wi-Fi): use o IP deste PC com :8766
echo Feche esta janela para desligar.
python -m http.server 8766
pause
