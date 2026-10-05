#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
const char* WIFI_SSID = "YOUR_WIFI"; const char* WIFI_PASS = "YOUR_PASSWORD";
WebServer server(80);
const int PUMP_PIN=26; const int SOIL_PIN=34; bool pump=false, autoMode=true;
void status(){ StaticJsonDocument<256> d; int raw=analogRead(SOIL_PIN); int soil=map(raw,4095,1200,0,100); soil=constrain(soil,0,100); d["soil"]=soil; d["pump"]=pump; d["auto"]=autoMode; d["waterTank"]=86; d["temperature"]=27.0; d["humidity"]=60; String out; serializeJson(d,out); server.send(200,"application/json",out); }
void pumpSet(){StaticJsonDocument<64>d;deserializeJson(d,server.arg("plain"));pump=d["on"]|false;digitalWrite(PUMP_PIN,pump);server.send(200,"application/json","{\"ok\":true}");}
void autoSet(){StaticJsonDocument<64>d;deserializeJson(d,server.arg("plain"));autoMode=d["enabled"]|false;server.send(200,"application/json","{\"ok\":true}");}
void setup(){pinMode(PUMP_PIN,OUTPUT);digitalWrite(PUMP_PIN,LOW);WiFi.begin(WIFI_SSID,WIFI_PASS);while(WiFi.status()!=WL_CONNECTED)delay(250);server.enableCORS(true);server.on("/api/status",HTTP_GET,status);server.on("/api/pump",HTTP_POST,pumpSet);server.on("/api/auto",HTTP_POST,autoSet);server.begin();}
void loop(){server.handleClient(); if(autoMode){int raw=analogRead(SOIL_PIN);int soil=map(raw,4095,1200,0,100);if(soil<35&&!pump){pump=true;digitalWrite(PUMP_PIN,HIGH);}if(soil>55&&pump){pump=false;digitalWrite(PUMP_PIN,LOW);}}}
