-- MariaDB dump 10.19  Distrib 10.4.32-MariaDB, for Win64 (AMD64)
--
-- Host: 127.0.0.1    Database: zaizens_payroll
-- ------------------------------------------------------
-- Server version	10.4.32-MariaDB

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `tbl_acl_audit`
--

DROP TABLE IF EXISTS `tbl_acl_audit`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_acl_audit` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `actor_id` int(11) DEFAULT NULL,
  `actor_name` varchar(120) DEFAULT NULL,
  `action` varchar(40) NOT NULL,
  `role` varchar(20) DEFAULT NULL,
  `target` varchar(160) DEFAULT NULL,
  `detail` text DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_acl_audit_created` (`created_at`),
  KEY `idx_acl_audit_role` (`role`,`created_at`),
  KEY `idx_acl_audit_action` (`action`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_acl_audit`
--

LOCK TABLES `tbl_acl_audit` WRITE;
/*!40000 ALTER TABLE `tbl_acl_audit` DISABLE KEYS */;
/*!40000 ALTER TABLE `tbl_acl_audit` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_acl_module`
--

DROP TABLE IF EXISTS `tbl_acl_module`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_acl_module` (
  `code` varchar(40) NOT NULL,
  `label` varchar(120) NOT NULL,
  `icon` varchar(40) DEFAULT 'fa-cube',
  `color` varchar(20) DEFAULT '#1a6bd8',
  `sort_order` int(11) DEFAULT 0,
  PRIMARY KEY (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_acl_module`
--

LOCK TABLES `tbl_acl_module` WRITE;
/*!40000 ALTER TABLE `tbl_acl_module` DISABLE KEYS */;
/*!40000 ALTER TABLE `tbl_acl_module` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_acl_role_portal`
--

DROP TABLE IF EXISTS `tbl_acl_role_portal`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_acl_role_portal` (
  `role` varchar(20) NOT NULL,
  `portal_code` varchar(40) NOT NULL,
  `is_home` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`role`,`portal_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_acl_role_portal`
--

LOCK TABLES `tbl_acl_role_portal` WRITE;
/*!40000 ALTER TABLE `tbl_acl_role_portal` DISABLE KEYS */;
/*!40000 ALTER TABLE `tbl_acl_role_portal` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_acl_role_ui_hidden`
--

DROP TABLE IF EXISTS `tbl_acl_role_ui_hidden`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_acl_role_ui_hidden` (
  `role` varchar(20) NOT NULL,
  `element_code` varchar(80) NOT NULL,
  PRIMARY KEY (`role`,`element_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_acl_role_ui_hidden`
--

LOCK TABLES `tbl_acl_role_ui_hidden` WRITE;
/*!40000 ALTER TABLE `tbl_acl_role_ui_hidden` DISABLE KEYS */;
/*!40000 ALTER TABLE `tbl_acl_role_ui_hidden` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_acl_ui_element`
--

DROP TABLE IF EXISTS `tbl_acl_ui_element`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_acl_ui_element` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(80) NOT NULL,
  `portal_code` varchar(40) NOT NULL,
  `kind` enum('sidebar','tile','card','button','section','stat','action_menu','topnav','topnav_item','fin_topnav','fin_topnav_item') NOT NULL,
  `parent_code` varchar(80) DEFAULT NULL,
  `label` varchar(160) NOT NULL,
  `url` varchar(255) DEFAULT NULL,
  `icon` varchar(40) DEFAULT NULL,
  `color` varchar(20) DEFAULT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `required_perm` varchar(255) NOT NULL DEFAULT '',
  `enabled` tinyint(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ui_code` (`code`),
  KEY `idx_portal_kind` (`portal_code`,`kind`,`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_acl_ui_element`
--

LOCK TABLES `tbl_acl_ui_element` WRITE;
/*!40000 ALTER TABLE `tbl_acl_ui_element` DISABLE KEYS */;
/*!40000 ALTER TABLE `tbl_acl_ui_element` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_employee`
--

DROP TABLE IF EXISTS `tbl_employee`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_employee` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `first_name` varchar(250) NOT NULL,
  `last_name` varchar(250) NOT NULL,
  `username` varchar(250) NOT NULL,
  `emailid` varchar(250) NOT NULL DEFAULT '',
  `password` varchar(250) NOT NULL,
  `dob` varchar(50) NOT NULL DEFAULT '',
  `gender` varchar(10) NOT NULL DEFAULT '',
  `address` text NOT NULL,
  `bio` text NOT NULL,
  `photo_path` varchar(255) DEFAULT NULL,
  `employee_id` varchar(250) NOT NULL DEFAULT '',
  `joining_date` varchar(250) NOT NULL DEFAULT '',
  `phone` varchar(32) NOT NULL DEFAULT '',
  `role` varchar(50) NOT NULL DEFAULT '101',
  `status` tinyint(4) NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `primary_department` varchar(120) DEFAULT NULL,
  `job_title` varchar(120) DEFAULT NULL,
  `cnps_number` varchar(32) NOT NULL DEFAULT '',
  `tax_niu` varchar(32) NOT NULL DEFAULT '',
  `nic_number` varchar(32) NOT NULL DEFAULT '',
  `bank_name` varchar(120) NOT NULL DEFAULT '',
  `bank_account_no` varchar(40) NOT NULL DEFAULT '',
  `specialisation` varchar(120) DEFAULT NULL,
  `profile_emoji` varchar(32) DEFAULT NULL,
  `profile_setup_complete` tinyint(1) NOT NULL DEFAULT 1,
  `password_must_change` tinyint(1) NOT NULL DEFAULT 0,
  `visit_start_date` date DEFAULT NULL,
  `visit_end_date` date DEFAULT NULL,
  `claimed_at` datetime DEFAULT NULL,
  `last_reset_at` datetime DEFAULT NULL,
  `preferred_consultation_room_id` int(11) DEFAULT NULL,
  `default_facility_id` int(11) DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_username` (`username`)
) ENGINE=InnoDB AUTO_INCREMENT=2367 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_employee`
--

LOCK TABLES `tbl_employee` WRITE;
/*!40000 ALTER TABLE `tbl_employee` DISABLE KEYS */;
INSERT INTO `tbl_employee` VALUES (1,'System','Admin','admin','admin@hms.com','$2a$10$JiiKiNJP5AdEpsVcrFHFu.3hhIdFlEofi4ouWmR3yplZdykL/n0/u','','Male','','',NULL,'','','','1',1,'2026-06-05 15:34:29','',NULL,'','','','','',NULL,NULL,1,0,NULL,NULL,NULL,NULL,NULL,1),(1228,'Super','Admin','super','super@localhost','$2y$10$dqOYJ3mBs1GDsO3CeqB6nurxJaCIahMgdjFa6ACSOr7xmgqrIVDU.','','','','Platform super administrator.',NULL,'SA-0','','','99',1,'2026-06-03 10:59:58',NULL,NULL,'','','','','',NULL,NULL,1,0,NULL,NULL,NULL,NULL,NULL,1),(1237,'Sr Theresia ','Filai','Filai','theresiafilai4@gmail.com','$2a$10$Td2webR5pMLMNk5gB1R6xuPhvWp10zxC5anz0eYKoxtF7ydAK0N7a','1988-10-27','Female','Soa ,Yaounde','General management and overseer of the hospital in every dimensions',NULL,'EMP-2026-00003','2026-01-14','681751749','106',1,'2026-06-06 11:01:48','Administration','','','','','','',NULL,'≡ƒæ⌐ΓÇìΓÜò∩╕Å',1,0,NULL,NULL,NULL,NULL,NULL,1),(1239,'Ha-ani Marie Therese','Berinyuy','Berinyuy','mariethereseberinyuy@gmail.com','$2a$10$t7bPBwHMIkSyn6ZX7bkwW.KPXO0FdYutwUpDM3OdbCBZV5nqVMSR2','','Female','TSSF SOA','Nurse ΓÇö Pharmacy',NULL,'EMP-2026-0004','2026-01-04','678986130','105',1,'2026-06-17 20:34:46','Pharmacy','HND Nurse','372-1017206-8','','','','',NULL,'👩‍🏫',1,0,NULL,NULL,NULL,NULL,NULL,1),(1240,'Wirnkar','Jaicomo','Jaicomo','wirnkarjacomo@gmail.com','$2a$10$KGD4ZGf0oTGEzu/BvhM28uem5Z1Mfm1aU0fUxpP1quNZSsekS559C','','Male','TSSF SOA','Nurse ΓÇö Medical unit',NULL,'EMP-2026-0005','2026-01-04','672728261','101',1,'2026-05-20 19:20:21','Medical Unit','HND Nurse','372-1017210-2','','','','',NULL,NULL,1,0,NULL,NULL,NULL,NULL,NULL,1),(1241,'Mahla Mary','Gladys','Gladys','mahlagladys24@gmail.com','$2a$10$bKQvbbyWyZRtJzHS9wv4R.Lm/dCSIqu3caCZAz8iJ.1q0cX5sbl1S','','Female','TSSF SOA','Nurse ΓÇö Medical unit',NULL,'EMP-2026-0006','2026-01-04','650201276','101',1,'2026-05-20 19:16:25','Medical Unit','NURSE','372-1017204-0','','','','',NULL,NULL,1,0,NULL,NULL,NULL,NULL,NULL,1),(1242,'Ekoume Letitia','Ndosiri','Letitia','ekoumeletitia@gmail.com','$2a$10$lNZFE..a6pLdYP3uvFzCiOXJAFokxlI4hLyCvcUKYsTjZ9UpzePwi','','Female','TSSF SOA','Nurse ΓÇö Medical unit',NULL,'EMP-2026-0007','2026-01-04','650120670','101',1,'2026-05-20 19:13:30','Medical Unit','BSC/HND Nurse','372-1017203-1','','','','',NULL,NULL,1,0,NULL,NULL,NULL,NULL,NULL,1),(1243,'Djieukam','Sedrick','Sedrick','sedrickdjieukam032@gmail.com','$2a$10$6fGwQzqBX/5n9nOj/JYZH.PiXsgwRHCLEBZnjBeFQLcXYqiH1ZA4u','','Male','TSSF SOA','Lab Tech ΓÇö Laboratory',NULL,'EMP-2026-0008','2026-01-04','654467058','102',1,'2026-05-20 19:11:59','Laboratory','HND Laboratory','372-1017209-5','','','','',NULL,NULL,1,0,NULL,NULL,NULL,NULL,NULL,1),(1244,'Achou Atumkeze Boris','Ghong','Ghong','batumkeze@gmail.com','$2a$10$2BinYd1gIKRrmrLR.JetX.Dv8x/BvwSgrRAY5VTe7gZkpWee5/Sse','','Male','TSSF SOA','Nurse ΓÇö Medical unit',NULL,'EMP-2026-0009','2026-01-04','676955620','101',1,'2026-05-20 19:10:38','Medical Unit','BSC Nurse','372-1017208-6','','','','',NULL,NULL,1,0,NULL,NULL,NULL,NULL,NULL,1),(1245,'Kongnyuy','Basil','Basil','kongnyuybaskid306@gmail.com','$2a$10$fes1FRmGKMluZPvmajbTjuc0ZT9173SCNzdz0pne/.280oApcjcnq','','Male','TSSF SOA','Nurse ΓÇö Medical unit',NULL,'EMP-2026-0010','2026-01-04','654726694','101',1,'2026-05-20 19:14:49','Medical Unit','NURSE','372-1017211-1','','','','',NULL,NULL,1,0,NULL,NULL,NULL,NULL,NULL,1),(1246,'Nkoi','Bless Koyioh Mgoh','Bless','nkolbless4@gmail.com','$2a$10$yFzUoj6fcUFYJFpwPGbc4eY86jWA4aXfHdRJcTxcy5MCMnR7QgjlW','','Male','TSSF SOA','Nurse ΓÇö Medical unit',NULL,'EMP-2026-0011','2026-01-04','682950639','101',1,'2026-05-20 19:17:09','Medical Unit','BSC/HND Nurse','372-1017207-7','','','','',NULL,NULL,1,0,NULL,NULL,NULL,NULL,NULL,1),(1247,'Lambiv Nadage','Awinya','Awinya','nadegelambiv@gmail.com','$2a$10$2t3HCtulQB9A/ia8G//WKuQ6Iv1x30ge/TSxsO1gXHrvi1UbJdVvq','','Female','TSSF SOA','midwife ΓÇö Maternity',NULL,'EMP-2026-0012','2026-01-04','670812560','101',1,'2026-05-20 19:15:28','Maternity','MIDWIFE','372-1017212-0','','','','',NULL,NULL,1,0,NULL,NULL,NULL,NULL,NULL,1),(1248,'Issa','Massai','Massai','issamassiq55@gmail.com','$2a$10$d8s2EYhZcBaR2KjcuWIF3.qvnB36ZGH12gy/Lv5vpDjpUyIl2DROC','','Male','TSSF SOA','midwife ΓÇö Maternity',NULL,'EMP-2026-0013','2026-01-04','670539696','101',1,'2026-05-20 19:14:15','Maternity','MIDWIFE','321-1071985-4','','','','',NULL,NULL,1,0,NULL,NULL,NULL,NULL,NULL,1),(1249,'Djufouo','Feugue Patriciane','Patricianne','patriciadjufouo@gmail.com','$2a$10$8tIyOP85r0ZcMgMyyd8hkeLxUAsnM0X9.aF0YacMTBwOCwRWq4b9S','','Female','TSSF SOA','midwife ΓÇö Maternity',NULL,'EMP-2026-0014','2026-01-04','651597042','101',1,'2026-05-20 19:12:31','Maternity','MIDWIFE','372-1017205-9','','','','',NULL,NULL,1,0,NULL,NULL,NULL,NULL,NULL,1),(1250,'Lariza ','Kinyuy','Lariza','Lariza_Kinyuy@gmail.com','$2a$10$lJ.mdCQAe2Xp9.gomhTYee1nrMP0LoaJCaQjr2zSK9uBxluOYx9SK','2000-12-23','Female','','Sr',NULL,'EMP-2026-00015','2026-05-01','673425458','107',1,'2026-05-23 02:38:37','ODP','','','','','','',NULL,NULL,1,0,NULL,NULL,NULL,NULL,NULL,1),(1251,'Maboh ','Rene','Maboh','mabohrene111@yahoo.com','$2a$10$mrAECtDnEQaz08fXKjMH8.8gbOvrXN/GUtoCat2oGSBew6uHVh/OW','1980-01-23','Male','','Cardiologist',NULL,'EMP-2026-00016','2026-05-01','674979091','106',1,'2026-06-05 15:34:29','Cardiology','','','','','','','Cardiologist',NULL,1,0,NULL,NULL,NULL,NULL,NULL,1),(1252,'Awelsa',' Beniot','Awelsa','awelsabenoit57@gmail.com','$2a$10$900TJrHYEzlzWZFfxGTsTe9Qbed6T1SQahucYn9qjzXynwD.T7l.y','1980-12-22','Male','','GP',NULL,'EMP-2026-00017','2026-05-09','693327126','100',1,'2026-06-17 20:34:21','ODP','','','','','','','General Practitioner','👨‍⚕️',1,0,NULL,NULL,NULL,NULL,NULL,1),(1253,'Raoul ','Tef','Tef','Raoul.tef@gmail.com','$2a$10$ByUrjnPJvWjdv3i6J1EJ8.E1NztZfZ9E/IOIUG282noHg7m.u.9La','1979-09-18','Male','','Radiology',NULL,'EMP-2026-00018','2026-04-24','696109229','104',1,'2026-05-24 03:04:55','Radiology','','','','','','',NULL,NULL,1,0,NULL,NULL,NULL,NULL,NULL,1),(1254,'Sidney','Tazeh','sidney.Tazeh','sidney.tazeh@staff.local','$2a$10$wBWvkIXuu7Z9cNYMxzbt0uO5zCJcrLh/TYhNbzW3Gmakt/N0s6ILG','','Male','Clear Radiology Buea','Sidney is an experienced and highly skilled Medical Physicist.  He is board certified by the American Board of Radiology ΓÇô ABR (2013) and has been practicing medical/radiological Physics for 14+ years. He currently works at the James A. Haley Medical Center, which is one of the biggest hospitals operated by the US government where he leads the Cyberknife Radiosurgery program.','staff-profiles/1779683292576-mzuhu5.jpg','EMP-2026-00019','2026-05-24','0000000000','106',1,'2026-06-05 15:34:29','Radiology','','','','','','','Radiologist','≡ƒæ¿ΓÇìΓÜò∩╕Å',1,0,NULL,NULL,NULL,NULL,NULL,1),(1255,'Mbakwa','Rickeins','mbakwa.Rickeins','mbakwa.rickeins@staff.local','$2a$10$OSP0m49NSkF2FdCdN54o3ustxjswabPRvmPaSmQT1pq7ZRFU2M5Hq','','Male','Clear Radiology Buea','Dr. Mbakwa Rickeins is a young vibrant, inspired and selfless medical doctor who has chosen to give his community prompt healthcare with diligence and dynamism.','staff-profiles/1779683116521-so4a0p.jpg','EMP-2026-00020','2026-05-24','0000000000','106',1,'2026-06-05 15:34:29','Medical Unit','','','','','','','General Practitioner','≡ƒæ¿ΓÇìΓÜò∩╕Å',1,0,NULL,NULL,NULL,NULL,NULL,1),(1256,'Desmond','Yenge','desmond.yenge','desmond.yenge@staff.local','$2a$10$14hdQ7EkRQJXWLdrj78U.Oa5L2xCIGzjrcoldDLEsYaVOKSK3IEju','','Male','Clear Radiology Buea','Dr. Yenge has a passion for treating underserved populations, having completed numerous medical missions throughout the world.','staff-profiles/1779682985460-o47hal.jpg','EMP-2026-00021','2026-05-24','0000000000','106',1,'2026-06-05 15:34:29','Urology','','','','','','','Urologist','≡ƒæ¿ΓÇìΓÜò∩╕Å',1,0,NULL,NULL,NULL,NULL,NULL,1),(1257,'Jessie','Titi','jessie.titi','jessie.titi@staff.local','$2a$10$WXq1LN1q1OsB5aBH7riHxeW28ItIhCYHGzcUqoCSmVL.m.CEJIIy.','','Female','Clear Radiology Buea','It takes a lot of patience, dedication and hard work to reach the top of oneΓÇÖs profession. Titi F. Jessie is a certified radiologic technologist/Diagnostic medical sonographer graduate; with over 5years of experience currently working with CBC health services, Bamenda-Nkwen.','staff-profiles/1779683055029-j8s4b6.jpg','EMP-2026-00022','2026-05-24','0000000000','107',1,'2026-05-25 07:48:51','Technology','','','','','','','Technologist','≡ƒæ¿ΓÇìΓÜò∩╕Å',1,0,NULL,NULL,NULL,NULL,NULL,1),(1258,'Mukeh','Pancratius','mukeh.pancratius','mukeh.pancratius@staff.local','$2a$10$6kJ2Cg4rhVwJZ3joBa2BYultL3LgUtM4xqBt.FgXYMcklEUlr4nf2','','Male','Clear Radiology Buea','Pancratius is a HealthCare and Data Analytic consultant and a Health IT and Health Information Exchange specialist with over 12 years of experience from the state of Texas. He is the founder and owner of iPing Solutions, which offers patient data management and advance health care analytics for hospitals and physician practices.','staff-profiles/mukeh.jpeg','EMP-2026-00023','2026-05-24','0000000000','101',1,'2026-05-25 07:48:51','Technology','','','','','','','\\','≡ƒæ¿ΓÇìΓÜò∩╕Å',1,0,NULL,NULL,NULL,NULL,NULL,1),(1259,'Peter','Tazeh','peter.tazeh','peter.tazeh@staff.local','$2a$10$mgm/TiE237nwqGt7FwLq3OMXAEupqZEfrJo//8xp8aNLMfTcnU1vu','','Male','Clear Radiology Buea','Trained in the US at Azusa Pacific University California, with a MasterΓÇÖs Degree in Finance and Administration, Mr Peter Tazeh brings in over 40yrs of experience in finance, administration and community leadership.','staff-profiles/1779683267300-tcrpe0.jpg','EMP-2026-00024','2026-05-24','0000000000','106',1,'2026-05-25 07:35:38','Administration','','','','','','','Administration','≡ƒæ¿ΓÇìΓÜò∩╕Å',1,0,NULL,NULL,NULL,NULL,NULL,1),(1260,'Ngii','Tazeh','ngii.tazeh','ngii.tazeh@staff.local','$2a$10$o4aoEnKAmsrBkNT6UBdXZuYUOjAC7z3QDBONQMG5f5Gs4O68qmSHS','','Male','Clear Radiology Buea','Dr. Ngii N. Tazeh is an urologist in Monroe, Wisconsin and is affiliated with┬áSSM Health Monroe Hospital. He received his medical degree from the University of Iowa Carver College of Medicine . After completing medical school Dr. Tazeh did his residency at the University of Wisconsin Hospital and Clinics were he received several outstanding resident awards.','staff-profiles/1779683215182-ss836e.jpg','EMP-2026-00025','2026-05-24','0000000000','101',1,'2026-05-25 07:48:51','Urology','','','','','','','Urologist','≡ƒæ¿ΓÇìΓÜò∩╕Å',1,0,NULL,NULL,NULL,NULL,NULL,1),(1261,'Kenedy','Foryoung','kenedy.foryoung','kenedy.foryoung@staff.local','$2a$10$/t2haK.F4XToYLvz8WP7puKREcvgsC.5BVPOTsteURWg4emGf/QVi','','Male','Clear Radiology Buea','Dr. Kenedy A. Foryoung is a graduate of Howard University College of Medicine (HUCM) with Honors, After medical school, Dr. Foryoung pursued his radiology residency training at Yale New Haven Hospital (YNHH). During his residency he made several presentations at national meetings.','staff-profiles/1779683080907-yh4o7u.jpg','EMP-2026-00026','2026-05-24','0000000000','101',1,'2026-05-25 07:48:51','Radiology','','','','','','','Radiologist','≡ƒæ¿ΓÇìΓÜò∩╕Å',1,0,NULL,NULL,NULL,NULL,NULL,1),(1262,'Geh Meh','Chu','geh.meh','geh.meh@staff.local','$2a$10$W.9S7r9GizpcLgT6CG0q9u8XaCKrGPZNOF8iggSeDTVagemUtXfGu','','Male','Clear Radiology Buea','Dr. Geh Meh Chu is a  very experienced Diagnostic and Interventional Radiologist currently working with Kent Diagnostic Radiology in Delaware, USA. Dr Chu is board certified by the American Board of Radiology and is an active member of the Society of Interventional Radiology.','staff-profiles/1779683010192-di697t.jpg','EMP-2026-00027','2026-05-24','0000000000','104',1,'2026-05-25 07:48:51','Radiology','','','','','','','Radiologist','≡ƒæ¿ΓÇìΓÜò∩╕Å',1,0,NULL,NULL,NULL,NULL,NULL,1),(1263,'Munoh Kenne','Foma','munoh.kenne','munoh.kenne@staff.local','$2a$10$rofWZoc1KImmhn4vEA1vi.C0nLpcvE.aAfCiFxnLHtimOq3uVHFbe','','Male','Clear Radiology Buea','Dr Foma is a US-trained internist with a sub-specialty in Hematology and Oncology. Before relocating the US, Dr Foma worked in Cameroon as a GP, Clinical pathologist, and public health specialist. He remains dedicated to providing his expertise in any Hematology and Oncology cases in Cameroon.','staff-profiles/1779683181704-h325pf.jpg','EMP-2026-00028','2026-05-24','0000000000','104',1,'2026-05-25 07:48:51','Hematology','','','','','','','Hematologist','≡ƒæ¿ΓÇìΓÜò∩╕Å',1,0,NULL,NULL,NULL,NULL,NULL,1),(1264,'Mary','Esele','mary.esele','mary.esele@staff.local','$2a$10$LZ.S9ma9NrrPXanrcEUz0O7dteWVA2K8Fjtqws44LaLoX8Y0/Inem','','Male','Clear Radiology Buea','Dr Esele is an Advanced Practice Registered Nurse, APRN, and a Doctor of Nursing Practice, DNP, who specializes in breast care. Esele is passionate about patient education and prides herself on her ability to establish clear lines of communication between patients and their family.','staff-profiles/1779682966748-3x2so8.jpg','EMP-2026-00029','2026-05-24','0000000000','105',1,'2026-05-25 07:48:51','Oncology','','','','','','','Breast Care Specialist','≡ƒæ¿ΓÇìΓÜò∩╕Å',1,0,NULL,NULL,NULL,NULL,NULL,1),(1265,'Nicholas','Ade','nicholas.ade','nicholas.ade@staff.local','$2a$10$.2PO8yBWnjyILbWJMlALS.A0s38w1bMo2xFjHOkJBgnKFGo/1AR9W','','Male','Clear Radiology Buea','Trained in South Africa at the University of the Witwatersrand and University of the Free State, Dr Ade holds postgraduate degrees with postdoctoral research experience in Radiotherapy Medical Physics. He is currently based in Cameroon and is a lecturer in Medical Physics at the University of Bamenda. In addition, he is completing a six-month residency in Diagnostic Radiology Physics at the University of the Free State in South Africa.','staff-profiles/1779682940683-qm0upl.jpg','EMP-2026-00030','2026-05-24','0000000000','102',1,'2026-05-25 07:48:51','Radiology','','','','','','','Radiologist','≡ƒæ¿ΓÇìΓÜò∩╕Å',1,0,NULL,NULL,NULL,NULL,NULL,1),(2346,'Visiting','Doctor 01','VD1','vd1@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-01','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2347,'Visiting','Doctor 02','VD2','vd2@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-02','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2348,'Visiting','Doctor 03','VD3','vd3@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-03','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2349,'Visiting','Doctor 04','VD4','vd4@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-04','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2350,'Visiting','Doctor 05','VD5','vd5@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-05','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2351,'Visiting','Doctor 06','VD6','vd6@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-06','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2352,'Visiting','Doctor 07','VD7','vd7@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-07','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2353,'Visiting','Doctor 08','VD8','vd8@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-08','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2354,'Visiting','Doctor 09','VD9','vd9@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-09','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2355,'Visiting','Doctor 10','VD10','vd10@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-10','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2356,'Visiting','Doctor 11','VD11','vd11@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-11','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2357,'Visiting','Doctor 12','VD12','vd12@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-12','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2358,'Visiting','Doctor 13','VD13','vd13@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-13','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2359,'Visiting','Doctor 14','VD14','vd14@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-14','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2360,'Visiting','Doctor 15','VD15','vd15@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-15','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2361,'Visiting','Doctor 16','VD16','vd16@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-16','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2362,'Visiting','Doctor 17','VD17','vd17@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-17','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2363,'Visiting','Doctor 18','VD18','vd18@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-18','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2364,'Visiting','Doctor 19','VD19','vd19@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-19','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2365,'Visiting','Doctor 20','VD20','vd20@visiting.local','$2a$10$xhcBj1ajKLLcV42xceJB.udfUSgtL0KD75KTxn3A6oIS23Zq6thQO','','Male','','',NULL,'VD-2026-20','2026-06-21','','110',1,'2026-06-21 15:24:12',NULL,NULL,'','','','','',NULL,NULL,0,1,NULL,NULL,NULL,NULL,NULL,1),(2366,'Payroll','Admin','payadmin','','$2a$10$JiiKiNJP5AdEpsVcrFHFu.3hhIdFlEofi4ouWmR3yplZdykL/n0/u','','','','',NULL,'PAY-ADMIN','2026-06-22','','1',1,'2026-06-22 03:30:31',NULL,NULL,'','','','','',NULL,NULL,1,0,NULL,NULL,NULL,NULL,NULL,1);
/*!40000 ALTER TABLE `tbl_employee` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_facility`
--

DROP TABLE IF EXISTS `tbl_facility`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_facility` (
  `id` int(11) NOT NULL,
  `name` varchar(255) DEFAULT NULL,
  `status` tinyint(4) DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `code` varchar(32) NOT NULL,
  `address` text DEFAULT NULL,
  `timezone` varchar(64) NOT NULL DEFAULT '''UTC''',
  `public_base_url` varchar(512) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_facility`
--

LOCK TABLES `tbl_facility` WRITE;
/*!40000 ALTER TABLE `tbl_facility` DISABLE KEYS */;
INSERT INTO `tbl_facility` VALUES (1,'TSSF  SOA',1,'2026-04-13 19:09:42','MAIN',NULL,'UTC',NULL);
/*!40000 ALTER TABLE `tbl_facility` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_facility_integration`
--

DROP TABLE IF EXISTS `tbl_facility_integration`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_facility_integration` (
  `facility_id` int(11) NOT NULL,
  `public_base_url` varchar(512) DEFAULT NULL,
  `core_account_url` varchar(512) DEFAULT NULL,
  `core_account_api_key` varchar(256) DEFAULT NULL,
  `core_account_sync_enabled` tinyint(4) NOT NULL DEFAULT 0,
  `hms_url` varchar(512) DEFAULT NULL,
  `hms_api_key_inbound` varchar(256) DEFAULT NULL,
  `zaizens_url` varchar(512) DEFAULT NULL,
  `zaizens_api_key_inbound` varchar(256) DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`facility_id`),
  CONSTRAINT `fk_fac_int_fac` FOREIGN KEY (`facility_id`) REFERENCES `tbl_facility` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_facility_integration`
--

LOCK TABLES `tbl_facility_integration` WRITE;
/*!40000 ALTER TABLE `tbl_facility_integration` DISABLE KEYS */;
INSERT INTO `tbl_facility_integration` VALUES (1,'','http://127.0.0.1:5072','dev-integration-key-change-in-production',1,'http://127.0.0.1:3003','dev-hms-inbound-key-change-in-production','','','2026-06-23 05:11:17');
/*!40000 ALTER TABLE `tbl_facility_integration` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_hms_allowance_settings`
--

DROP TABLE IF EXISTS `tbl_hms_allowance_settings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_hms_allowance_settings` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `facility_id` int(11) NOT NULL,
  `sector` varchar(40) NOT NULL DEFAULT 'medical',
  `code` varchar(40) NOT NULL,
  `label` varchar(120) NOT NULL DEFAULT '',
  `label_fr` varchar(120) NOT NULL DEFAULT '',
  `calc_type` varchar(20) NOT NULL DEFAULT 'none',
  `enabled` tinyint(1) NOT NULL DEFAULT 1,
  `pct_value` decimal(8,3) DEFAULT NULL,
  `fixed_amount` decimal(14,2) DEFAULT NULL,
  `per_unit_amount` decimal(14,2) DEFAULT NULL,
  `cap_pct` decimal(8,3) DEFAULT NULL,
  `cap_amount` decimal(14,2) DEFAULT NULL,
  `applies_to_roles` text DEFAULT NULL,
  `legal_basis` varchar(255) NOT NULL DEFAULT '',
  `description` text DEFAULT NULL,
  `sort_order` smallint(6) NOT NULL DEFAULT 99,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_hms_allow_fac_sec_code` (`facility_id`,`sector`,`code`),
  KEY `idx_hms_allow_fac_sec` (`facility_id`,`sector`)
) ENGINE=InnoDB AUTO_INCREMENT=1091 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_hms_allowance_settings`
--

LOCK TABLES `tbl_hms_allowance_settings` WRITE;
/*!40000 ALTER TABLE `tbl_hms_allowance_settings` DISABLE KEYS */;
INSERT INTO `tbl_hms_allowance_settings` VALUES (1,1,'medical','seniority','Seniority Bonus','Prime d\'Anciennet├⌐','seniority_scale',1,NULL,NULL,NULL,30.000,NULL,NULL,'Labour Code Art.68 | Conv. Coll. Sant├⌐ Priv├⌐e Cameroun','Rate = completed years of service % (2% at 2yrs, 3% at 3yrs ΓÇª 30% ceiling). Formula: rate ├ù Basic Salary. Requires hire date on employee pay profile.',1,'2026-05-20 08:31:39'),(2,1,'medical','medical_responsibility','Medical Responsibility Allowance','Prime de Responsabilit├⌐ M├⌐dicale','pct_basic',1,25.000,NULL,2500.00,NULL,NULL,'[2]','Conv. Coll. Sant├⌐ Priv├⌐e Cameroun, Art.32 ΓÇö M├⌐decins & Chirurgiens','25% of basic salary for licensed medical doctors. Adjust the percentage to match your establishment\'s collective agreement annex.',2,'2026-05-20 16:16:51'),(3,1,'medical','specialist_research','Specialist Research Allowance','Prime de Recherche Sp├⌐cialis├⌐e','pct_basic',1,15.000,NULL,3500.00,NULL,NULL,'[2]','Decree No.95/040 on healthcare professional remuneration','15% of basic salary for specialist-grade doctors (e.g. Surgeon, Cardiologist).',3,'2026-05-20 16:16:52'),(4,1,'medical','medical_risk','Medical Risk Allowance','Indemnit├⌐ d\'Exposition au Risque M├⌐dical','pct_basic',1,10.000,NULL,NULL,NULL,NULL,'[2,4,5,6,7,8]','Conv. Coll. Sant├⌐ Priv├⌐e Cameroun | Law No.96/03 of 4 Jan 1996 (health protection)','10% of basic salary for clinical staff with direct patient or biological-sample exposure (Doctors, Lab, Pharmacy, Radiology, Nurses, Nursing Aids).',4,'2026-05-20 16:16:52'),(5,1,'medical','night_duty','Night Duty Allowance','Indemnit├⌐ de Garde de Nuit','per_shift',1,NULL,NULL,2500.00,NULL,NULL,NULL,'Labour Code Art.80 (night work supplements) | Conv. Coll. Sant├⌐ Priv├⌐e','Paid for each night shift (22:00–06:00). The XAF amount in the rate box × the number of nights on the Nurse Roster for the month. Counts are read directly from the duty roster — no manual entry needed. Paid TAX-FREE on top of net (not subject to CNPS, CFC, CRTV, IRPP or CAC).',5,'2026-06-22 03:34:23'),(6,1,'medical','on_call','On-Call Allowance','Prime d\'Astreinte','per_shift',1,NULL,NULL,4500.00,NULL,NULL,NULL,'Labour Code Art.80 | Conv. Coll. Sant├⌐ Priv├⌐e Cameroun','Paid for each on-call session. The XAF amount in the rate box × the number of on-call sessions on the Doctor Roster for the month (marked \"OC\" / On-Call). Counts are read directly from the duty roster — no manual entry needed. Paid TAX-FREE on top of net (not subject to CNPS, CFC, CRTV, IRPP or CAC).',6,'2026-06-22 03:34:23'),(7,1,'medical','technical','Technical Allowance','Prime Technique','pct_basic',1,15.000,NULL,NULL,NULL,NULL,'[4,5,6]','Conv. Coll. Sant├⌐ Priv├⌐e Cameroun ΓÇö Annexe Personnel Param├⌐dical Technique | Labour Code Art.71','15% of basic salary for technical paramedical staff (Lab Technicians, Pharmacists/Dispensers, Radiographers). Distinct from the public-sector flat prime de technicit├⌐ (civil-service grades). May stack with Medical Risk Allowance (10%) where both apply.',7,'2026-05-20 16:16:52'),(8,1,'medical','diligence','Diligence / Punctuality Bonus','Prime d\'Assiduit├⌐','pct_basic',0,5.000,NULL,NULL,NULL,NULL,NULL,'Conv. Coll. Sant├⌐ Priv├⌐e Cameroun','5% of basic salary for full attendance in the month. Enable per employee as needed; disable for staff with absences in the period.',8,'2026-05-20 08:31:39'),(9,1,'medical','head_of_dept','Head of Department Allowance','Prime de Chef de Service / Responsable d\'Unit├⌐','fixed',0,NULL,30000.00,NULL,NULL,NULL,'[2,7]','Conv. Coll. Sant├⌐ Priv├⌐e Cameroun ΓÇö Annexe Encadrement','30,000 XAF fixed monthly for heads of department (Ward Sisters, Chief Doctors, Unit Heads). Enable this allowance only for qualifying staff.',9,'2026-05-20 16:16:52'),(10,1,'medical','maternity_obstetric','Maternity / Obstetric Allowance','Prime d\'Obst├⌐trique et Maternit├⌐','pct_basic',0,10.000,NULL,NULL,NULL,NULL,'[7,8]','Conv. Coll. Sant├⌐ Priv├⌐e ΓÇö Personnels de Maternit├⌐ & Obst├⌐trique','10% of basic salary for midwives and obstetric nursing staff. Enable for staff assigned to the maternity/labour ward.',10,'2026-05-20 16:16:52');
/*!40000 ALTER TABLE `tbl_hms_allowance_settings` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_hms_attendance`
--

DROP TABLE IF EXISTS `tbl_hms_attendance`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_hms_attendance` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `facility_id` int(11) NOT NULL,
  `employee_id` int(11) NOT NULL,
  `att_date` date NOT NULL,
  `check_in_time` time DEFAULT NULL,
  `check_out_time` time DEFAULT NULL,
  `status` varchar(24) NOT NULL DEFAULT 'present',
  `notes` varchar(500) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_hms_att` (`facility_id`,`employee_id`,`att_date`),
  KEY `idx_hms_att_fac_date` (`facility_id`,`att_date`),
  KEY `idx_hms_att_emp` (`employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_hms_attendance`
--

LOCK TABLES `tbl_hms_attendance` WRITE;
/*!40000 ALTER TABLE `tbl_hms_attendance` DISABLE KEYS */;
/*!40000 ALTER TABLE `tbl_hms_attendance` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_hms_dipe_history`
--

DROP TABLE IF EXISTS `tbl_hms_dipe_history`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_hms_dipe_history` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `facility_id` int(11) NOT NULL,
  `month` tinyint(4) NOT NULL,
  `year` smallint(6) NOT NULL,
  `filename` varchar(255) NOT NULL,
  `file_path` varchar(512) NOT NULL DEFAULT '',
  `generated_by` int(11) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_hms_dipe_fac_ym` (`facility_id`,`year`,`month`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_hms_dipe_history`
--

LOCK TABLES `tbl_hms_dipe_history` WRITE;
/*!40000 ALTER TABLE `tbl_hms_dipe_history` DISABLE KEYS */;
INSERT INTO `tbl_hms_dipe_history` VALUES (1,1,5,2026,'DIPE_1_202605_1779300357675.txt','data/dipe/DIPE_1_202605_1779300357675.txt',1228,'2026-05-20 18:05:57');
/*!40000 ALTER TABLE `tbl_hms_dipe_history` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_hms_holiday`
--

DROP TABLE IF EXISTS `tbl_hms_holiday`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_hms_holiday` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `facility_id` int(11) NOT NULL,
  `holiday_name` varchar(120) NOT NULL,
  `holiday_date` date NOT NULL,
  `is_recurring` tinyint(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `idx_hms_hol_fac_date` (`facility_id`,`holiday_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_hms_holiday`
--

LOCK TABLES `tbl_hms_holiday` WRITE;
/*!40000 ALTER TABLE `tbl_hms_holiday` DISABLE KEYS */;
/*!40000 ALTER TABLE `tbl_hms_holiday` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_hms_leave_balance`
--

DROP TABLE IF EXISTS `tbl_hms_leave_balance`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_hms_leave_balance` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `facility_id` int(11) NOT NULL,
  `employee_id` int(11) NOT NULL,
  `leave_type` varchar(24) NOT NULL,
  `year` smallint(6) NOT NULL,
  `balance` decimal(6,2) NOT NULL DEFAULT 0.00,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_hms_leave_bal` (`facility_id`,`employee_id`,`leave_type`,`year`),
  KEY `idx_leave_bal_fac` (`facility_id`),
  KEY `idx_leave_bal_emp` (`employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_hms_leave_balance`
--

LOCK TABLES `tbl_hms_leave_balance` WRITE;
/*!40000 ALTER TABLE `tbl_hms_leave_balance` DISABLE KEYS */;
/*!40000 ALTER TABLE `tbl_hms_leave_balance` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_hms_leave_request`
--

DROP TABLE IF EXISTS `tbl_hms_leave_request`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_hms_leave_request` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `facility_id` int(11) NOT NULL,
  `employee_id` int(11) NOT NULL,
  `leave_type` varchar(24) NOT NULL DEFAULT 'annual',
  `start_date` date NOT NULL,
  `end_date` date NOT NULL,
  `days_requested` decimal(6,2) NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'pending',
  `reason` text DEFAULT NULL,
  `approved_by` int(11) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_hms_leave_fac_st` (`facility_id`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_hms_leave_request`
--

LOCK TABLES `tbl_hms_leave_request` WRITE;
/*!40000 ALTER TABLE `tbl_hms_leave_request` DISABLE KEYS */;
/*!40000 ALTER TABLE `tbl_hms_leave_request` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_hms_pay_profile`
--

DROP TABLE IF EXISTS `tbl_hms_pay_profile`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_hms_pay_profile` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `facility_id` int(11) NOT NULL,
  `employee_id` int(11) NOT NULL,
  `basic_salary` decimal(14,2) NOT NULL DEFAULT 0.00,
  `housing_allowance` decimal(14,2) NOT NULL DEFAULT 0.00,
  `transport_allowance` decimal(14,2) NOT NULL DEFAULT 0.00,
  `other_allowances` decimal(14,2) NOT NULL DEFAULT 0.00,
  `hire_date` date DEFAULT NULL,
  `sector` varchar(40) NOT NULL DEFAULT 'medical',
  `night_shifts_per_month` smallint(6) NOT NULL DEFAULT 0,
  `on_call_per_month` smallint(6) NOT NULL DEFAULT 0,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `medical_risk_allowance` int(11) NOT NULL DEFAULT 0 COMMENT 'Flat monthly medical risk / hardship premium (XAF)',
  `responsibility_allowance` int(11) NOT NULL DEFAULT 0 COMMENT 'Flat monthly responsibility / specialist supplement (XAF)',
  `is_specialist` tinyint(1) NOT NULL DEFAULT 0 COMMENT '1 = specialist-grade doctor (Surgeon, Cardiologist, etc.) — unlocks Specialist Research Allowance',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_hms_pay_prof` (`facility_id`,`employee_id`),
  KEY `idx_pay_prof_fac` (`facility_id`),
  KEY `idx_pay_prof_emp` (`employee_id`)
) ENGINE=InnoDB AUTO_INCREMENT=64 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_hms_pay_profile`
--

LOCK TABLES `tbl_hms_pay_profile` WRITE;
/*!40000 ALTER TABLE `tbl_hms_pay_profile` DISABLE KEYS */;
INSERT INTO `tbl_hms_pay_profile` VALUES (1,1,1228,0.00,0.00,0.00,0.00,NULL,'medical',0,0,'2026-05-20 17:02:08',0,0,0),(2,1,1247,91661.00,13749.00,9166.00,0.00,'2026-01-04','medical',0,0,'2026-05-20 16:38:35',0,0,0),(3,1,1245,88889.00,13333.00,8889.00,0.00,'2026-01-04','medical',0,0,'2026-05-20 16:38:35',0,0,0),(4,1,1239,82041.00,12306.00,8204.00,0.00,'2026-01-04','medical',0,0,'2026-05-20 16:38:35',0,0,0),(5,1,1246,91661.00,13749.00,9166.00,0.00,'2026-01-04','medical',0,0,'2026-05-20 16:40:01',0,0,0),(21,1,1240,82041.00,12306.00,8204.00,0.00,'2026-01-04','medical',0,0,'2026-05-20 16:29:28',0,0,0),(22,1,1248,91661.00,13749.00,9166.00,0.00,'2026-01-04','medical',0,0,'2026-05-20 16:29:28',0,0,0),(23,1,1242,91661.00,13749.00,9166.00,0.00,'2026-01-04','medical',0,0,'2026-05-20 16:29:28',0,0,0),(24,1,1243,82041.00,12306.00,8204.00,0.00,'2026-01-04','medical',0,0,'2026-05-20 16:29:28',0,0,0),(30,1,1,0.00,0.00,0.00,0.00,NULL,'medical',0,0,'2026-05-20 16:38:35',0,0,0),(35,1,1249,91661.00,13749.00,9166.00,0.00,'2026-01-04','medical',0,0,'2026-05-20 16:40:01',0,0,0),(36,1,1237,0.00,0.00,0.00,0.00,'2026-01-14','medical',0,0,'2026-05-20 16:40:01',0,0,0),(37,1,1244,91661.00,13749.00,9166.00,0.00,'2026-01-04','medical',0,0,'2026-05-20 16:40:01',0,0,0),(38,1,1241,82041.00,12306.00,8204.00,0.00,'2026-01-04','medical',0,0,'2026-05-20 16:40:01',0,0,0),(39,1,1252,0.00,0.00,0.00,0.00,'2026-05-09','medical',0,0,'2026-06-22 21:09:03',0,0,0),(40,1,1265,0.00,0.00,0.00,0.00,'2026-05-24','medical',0,0,'2026-06-22 21:09:03',0,0,0),(41,1,2366,0.00,0.00,0.00,0.00,'2026-06-22','medical',0,0,'2026-06-22 21:09:03',0,0,0),(48,1,1262,0.00,0.00,0.00,0.00,'2026-05-24','medical',0,0,'2026-06-22 21:09:03',0,0,0),(49,1,2346,0.00,0.00,0.00,0.00,'2026-06-21','medical',0,0,'2026-06-22 21:09:03',0,0,0),(50,1,2347,0.00,0.00,0.00,0.00,'2026-06-21','medical',0,0,'2026-06-22 21:09:03',0,0,0),(51,1,2348,0.00,0.00,0.00,0.00,'2026-06-21','medical',0,0,'2026-06-22 21:09:03',0,0,0),(52,1,2349,0.00,0.00,0.00,0.00,'2026-06-21','medical',0,0,'2026-06-22 21:09:03',0,0,0),(53,1,2350,0.00,0.00,0.00,0.00,'2026-06-21','medical',0,0,'2026-06-22 21:09:03',0,0,0),(54,1,2351,0.00,0.00,0.00,0.00,'2026-06-21','medical',0,0,'2026-06-22 21:09:03',0,0,0),(55,1,2352,0.00,0.00,0.00,0.00,'2026-06-21','medical',0,0,'2026-06-22 21:09:03',0,0,0),(56,1,2353,0.00,0.00,0.00,0.00,'2026-06-21','medical',0,0,'2026-06-22 21:09:03',0,0,0),(57,1,2354,0.00,0.00,0.00,0.00,'2026-06-21','medical',0,0,'2026-06-22 21:09:03',0,0,0),(58,1,2355,0.00,0.00,0.00,0.00,'2026-06-21','medical',0,0,'2026-06-22 21:09:03',0,0,0),(59,1,2356,0.00,0.00,0.00,0.00,'2026-06-21','medical',0,0,'2026-06-22 21:09:03',0,0,0),(60,1,2357,0.00,0.00,0.00,0.00,'2026-06-21','medical',0,0,'2026-06-22 21:09:03',0,0,0),(61,1,2358,0.00,0.00,0.00,0.00,'2026-06-21','medical',0,0,'2026-06-22 21:09:03',0,0,0),(62,1,2359,0.00,0.00,0.00,0.00,'2026-06-21','medical',0,0,'2026-06-22 21:09:03',0,0,0),(63,1,2360,0.00,0.00,0.00,0.00,'2026-06-21','medical',0,0,'2026-06-22 21:09:03',0,0,0);
/*!40000 ALTER TABLE `tbl_hms_pay_profile` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_hms_payroll_dept_summary`
--

DROP TABLE IF EXISTS `tbl_hms_payroll_dept_summary`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_hms_payroll_dept_summary` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `facility_id` int(11) NOT NULL DEFAULT 1,
  `year` smallint(6) NOT NULL,
  `month` tinyint(4) NOT NULL,
  `department_name` varchar(120) NOT NULL DEFAULT '',
  `headcount` int(11) NOT NULL DEFAULT 0,
  `gross_payroll` decimal(18,2) NOT NULL DEFAULT 0.00,
  `net_payroll` decimal(18,2) NOT NULL DEFAULT 0.00,
  `employer_charges` decimal(18,2) NOT NULL DEFAULT 0.00,
  `cnps_employee` decimal(18,2) NOT NULL DEFAULT 0.00,
  `cnps_employer` decimal(18,2) NOT NULL DEFAULT 0.00,
  `income_tax` decimal(18,2) NOT NULL DEFAULT 0.00,
  `other_deductions` decimal(18,2) NOT NULL DEFAULT 0.00,
  `core_period_id` varchar(64) DEFAULT NULL,
  `synced_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_period_dept` (`facility_id`,`year`,`month`,`department_name`)
) ENGINE=InnoDB AUTO_INCREMENT=44 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_hms_payroll_dept_summary`
--

LOCK TABLES `tbl_hms_payroll_dept_summary` WRITE;
/*!40000 ALTER TABLE `tbl_hms_payroll_dept_summary` DISABLE KEYS */;
INSERT INTO `tbl_hms_payroll_dept_summary` VALUES (1,1,2026,6,'Laboratory',1,123061.00,103345.00,16859.36,0.00,0.00,0.00,0.00,NULL,'2026-06-22 22:28:38'),(2,1,2026,6,'Maternity',3,371226.00,311742.00,50857.96,0.00,0.00,0.00,0.00,NULL,'2026-06-22 22:28:38'),(3,1,2026,6,'Medical Unit',6,712736.00,598738.00,97644.83,0.00,0.00,0.00,0.00,NULL,'2026-06-22 22:28:38'),(4,1,2026,6,'Pharmacy',1,110755.00,93099.00,15173.44,0.00,0.00,0.00,0.00,NULL,'2026-06-22 22:28:38'),(5,1,2026,5,'Laboratory',1,102551.00,77288.59,14049.49,0.00,0.00,0.00,0.00,NULL,'2026-06-22 22:29:16'),(6,1,2026,5,'Maternity',3,343728.00,259054.05,47090.74,0.00,0.00,0.00,0.00,NULL,'2026-06-22 22:29:16'),(7,1,2026,5,'Medical Unit',6,659941.00,497371.15,90411.92,0.00,0.00,0.00,0.00,NULL,'2026-06-22 22:29:16'),(8,1,2026,5,'Pharmacy',1,102551.00,77288.59,14049.49,0.00,0.00,0.00,0.00,NULL,'2026-06-22 22:29:16'),(9,1,2026,1,'Laboratory',1,123061.00,103345.00,16859.36,0.00,0.00,0.00,0.00,NULL,'2026-06-22 23:20:29'),(10,1,2026,1,'Maternity',3,371226.00,311742.00,50857.96,0.00,0.00,0.00,0.00,NULL,'2026-06-22 23:20:29'),(11,1,2026,1,'Medical Unit',6,712736.00,598738.00,97644.83,0.00,0.00,0.00,0.00,NULL,'2026-06-22 23:20:29'),(12,1,2026,1,'Pharmacy',1,123061.00,103345.00,16859.36,0.00,0.00,0.00,0.00,NULL,'2026-06-22 23:20:29'),(13,1,2026,2,'Laboratory',1,123061.00,103345.00,16859.36,0.00,0.00,0.00,0.00,NULL,'2026-06-22 23:18:42'),(14,1,2026,2,'Maternity',3,371226.00,311742.00,50857.96,0.00,0.00,0.00,0.00,NULL,'2026-06-22 23:18:42'),(15,1,2026,2,'Medical Unit',6,712736.00,598738.00,97644.83,0.00,0.00,0.00,0.00,NULL,'2026-06-22 23:18:42'),(16,1,2026,2,'Pharmacy',1,123061.00,103345.00,16859.36,0.00,0.00,0.00,0.00,NULL,'2026-06-22 23:18:42'),(17,1,2026,3,'Laboratory',1,123061.00,103345.00,16859.36,0.00,0.00,0.00,0.00,NULL,'2026-06-22 23:18:49'),(18,1,2026,3,'Maternity',3,371226.00,311742.00,50857.96,0.00,0.00,0.00,0.00,NULL,'2026-06-22 23:18:49'),(19,1,2026,3,'Medical Unit',6,712736.00,598738.00,97644.83,0.00,0.00,0.00,0.00,NULL,'2026-06-22 23:18:49'),(20,1,2026,3,'Pharmacy',1,123061.00,103345.00,16859.36,0.00,0.00,0.00,0.00,NULL,'2026-06-22 23:18:49');
/*!40000 ALTER TABLE `tbl_hms_payroll_dept_summary` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_hms_payroll_record`
--

DROP TABLE IF EXISTS `tbl_hms_payroll_record`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_hms_payroll_record` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `facility_id` int(11) NOT NULL,
  `employee_id` int(11) NOT NULL,
  `year` smallint(6) NOT NULL,
  `month` tinyint(4) NOT NULL,
  `gross_salary` decimal(14,2) NOT NULL DEFAULT 0.00,
  `cnps_employee` decimal(14,2) NOT NULL DEFAULT 0.00,
  `cimr_employee` decimal(14,2) NOT NULL DEFAULT 0.00,
  `crtv_deduction` decimal(14,2) NOT NULL DEFAULT 0.00,
  `council_tax_deduction` decimal(14,2) NOT NULL DEFAULT 0.00,
  `development_tax_deduction` decimal(14,2) NOT NULL DEFAULT 0.00,
  `cnhc_deduction` decimal(14,2) NOT NULL DEFAULT 0.00,
  `taxable_income` decimal(14,2) DEFAULT NULL,
  `income_tax` decimal(14,2) NOT NULL DEFAULT 0.00,
  `net_salary` decimal(14,2) NOT NULL DEFAULT 0.00,
  `basic_salary_snap` decimal(14,2) DEFAULT NULL,
  `housing_allowance_snap` decimal(14,2) DEFAULT NULL,
  `transport_allowance_snap` decimal(14,2) DEFAULT NULL,
  `other_allowances_snap` decimal(14,2) DEFAULT NULL,
  `payment_date` date DEFAULT NULL,
  `payout_status` varchar(16) NOT NULL DEFAULT 'pending',
  `allowances_snap` text DEFAULT NULL,
  `non_taxable_allowance` decimal(14,2) NOT NULL DEFAULT 0.00,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_hms_payroll_rec_fac_emp_ym` (`facility_id`,`employee_id`,`year`,`month`),
  KEY `idx_hms_payroll_rec_fac_ym` (`facility_id`,`year`,`month`),
  KEY `idx_payroll_emp` (`employee_id`)
) ENGINE=InnoDB AUTO_INCREMENT=148 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_hms_payroll_record`
--

LOCK TABLES `tbl_hms_payroll_record` WRITE;
/*!40000 ALTER TABLE `tbl_hms_payroll_record` DISABLE KEYS */;
INSERT INTO `tbl_hms_payroll_record` VALUES (137,1,1247,2026,1,123742.00,5197.00,1237.00,3000.00,700.00,1237.00,769.00,76878.00,7688.00,103914.00,91661.00,13749.00,9166.00,0.00,NULL,'pending','{\"total\":9166,\"lines\":[{\"code\":\"medical_risk\",\"label\":\"Medical Risk Allowance\",\"label_fr\":\"Indemnit├⌐ d\'Exposition au Risque M├⌐dical\",\"amount\":9166,\"qty_label\":\"10%\",\"rate_label\":\"91 661\"}]}',0.00,'2026-06-22 22:20:29'),(138,1,1245,2026,1,120000.00,5040.00,1200.00,3000.00,700.00,1200.00,733.00,73293.00,7329.00,100798.00,88889.00,13333.00,8889.00,0.00,NULL,'pending','{\"total\":8889,\"lines\":[{\"code\":\"medical_risk\",\"label\":\"Medical Risk Allowance\",\"label_fr\":\"Indemnit├⌐ d\'Exposition au Risque M├⌐dical\",\"amount\":8889,\"qty_label\":\"10%\",\"rate_label\":\"88 889\"}]}',0.00,'2026-06-22 22:20:29'),(139,1,1239,2026,1,123061.00,5169.00,1231.00,3000.00,700.00,1231.00,762.00,76225.00,7623.00,103345.00,82041.00,12306.00,8204.00,0.00,NULL,'pending','{\"total\":20510,\"lines\":[{\"code\":\"medical_risk\",\"label\":\"Medical Risk Allowance\",\"label_fr\":\"Indemnit├⌐ d\'Exposition au Risque M├⌐dical\",\"amount\":8204,\"qty_label\":\"10%\",\"rate_label\":\"82 041\"},{\"code\":\"technical\",\"label\":\"Technical Allowance\",\"label_fr\":\"Prime Technique\",\"amount\":12306,\"qty_label\":\"15%\",\"rate_label\":\"82 041\"}]}',0.00,'2026-06-22 22:20:29'),(140,1,1246,2026,1,123742.00,5197.00,1237.00,3000.00,700.00,1237.00,769.00,76878.00,7688.00,103914.00,91661.00,13749.00,9166.00,0.00,NULL,'pending','{\"total\":9166,\"lines\":[{\"code\":\"medical_risk\",\"label\":\"Medical Risk Allowance\",\"label_fr\":\"Indemnit├⌐ d\'Exposition au Risque M├⌐dical\",\"amount\":9166,\"qty_label\":\"10%\",\"rate_label\":\"91 661\"}]}',0.00,'2026-06-22 22:20:29'),(141,1,1249,2026,1,123742.00,5197.00,1237.00,3000.00,700.00,1237.00,769.00,76878.00,7688.00,103914.00,91661.00,13749.00,9166.00,0.00,NULL,'pending','{\"total\":9166,\"lines\":[{\"code\":\"medical_risk\",\"label\":\"Medical Risk Allowance\",\"label_fr\":\"Indemnit├⌐ d\'Exposition au Risque M├⌐dical\",\"amount\":9166,\"qty_label\":\"10%\",\"rate_label\":\"91 661\"}]}',0.00,'2026-06-22 22:20:29'),(142,1,1244,2026,1,123742.00,5197.00,1237.00,3000.00,700.00,1237.00,769.00,76878.00,7688.00,103914.00,91661.00,13749.00,9166.00,0.00,NULL,'pending','{\"total\":9166,\"lines\":[{\"code\":\"medical_risk\",\"label\":\"Medical Risk Allowance\",\"label_fr\":\"Indemnit├⌐ d\'Exposition au Risque M├⌐dical\",\"amount\":9166,\"qty_label\":\"10%\",\"rate_label\":\"91 661\"}]}',0.00,'2026-06-22 22:20:29'),(143,1,1241,2026,1,110755.00,4652.00,1108.00,3000.00,700.00,1108.00,644.00,64436.00,6444.00,93099.00,82041.00,12306.00,8204.00,0.00,NULL,'pending','{\"total\":8204,\"lines\":[{\"code\":\"medical_risk\",\"label\":\"Medical Risk Allowance\",\"label_fr\":\"Indemnit├⌐ d\'Exposition au Risque M├⌐dical\",\"amount\":8204,\"qty_label\":\"10%\",\"rate_label\":\"82 041\"}]}',0.00,'2026-06-22 22:20:29'),(144,1,1240,2026,1,110755.00,4652.00,1108.00,3000.00,700.00,1108.00,644.00,64436.00,6444.00,93099.00,82041.00,12306.00,8204.00,0.00,NULL,'pending','{\"total\":8204,\"lines\":[{\"code\":\"medical_risk\",\"label\":\"Medical Risk Allowance\",\"label_fr\":\"Indemnit├⌐ d\'Exposition au Risque M├⌐dical\",\"amount\":8204,\"qty_label\":\"10%\",\"rate_label\":\"82 041\"}]}',0.00,'2026-06-22 22:20:29'),(145,1,1248,2026,1,123742.00,5197.00,1237.00,3000.00,700.00,1237.00,769.00,76878.00,7688.00,103914.00,91661.00,13749.00,9166.00,0.00,NULL,'pending','{\"total\":9166,\"lines\":[{\"code\":\"medical_risk\",\"label\":\"Medical Risk Allowance\",\"label_fr\":\"Indemnit├⌐ d\'Exposition au Risque M├⌐dical\",\"amount\":9166,\"qty_label\":\"10%\",\"rate_label\":\"91 661\"}]}',0.00,'2026-06-22 22:20:29'),(146,1,1242,2026,1,123742.00,5197.00,1237.00,3000.00,700.00,1237.00,769.00,76878.00,7688.00,103914.00,91661.00,13749.00,9166.00,0.00,NULL,'pending','{\"total\":9166,\"lines\":[{\"code\":\"medical_risk\",\"label\":\"Medical Risk Allowance\",\"label_fr\":\"Indemnit├⌐ d\'Exposition au Risque M├⌐dical\",\"amount\":9166,\"qty_label\":\"10%\",\"rate_label\":\"91 661\"}]}',0.00,'2026-06-22 22:20:29'),(147,1,1243,2026,1,123061.00,5169.00,1231.00,3000.00,700.00,1231.00,762.00,76225.00,7623.00,103345.00,82041.00,12306.00,8204.00,0.00,NULL,'pending','{\"total\":20510,\"lines\":[{\"code\":\"medical_risk\",\"label\":\"Medical Risk Allowance\",\"label_fr\":\"Indemnit├⌐ d\'Exposition au Risque M├⌐dical\",\"amount\":8204,\"qty_label\":\"10%\",\"rate_label\":\"82 041\"},{\"code\":\"technical\",\"label\":\"Technical Allowance\",\"label_fr\":\"Prime Technique\",\"amount\":12306,\"qty_label\":\"15%\",\"rate_label\":\"82 041\"}]}',0.00,'2026-06-22 22:20:29');
/*!40000 ALTER TABLE `tbl_hms_payroll_record` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_hms_payroll_settings`
--

DROP TABLE IF EXISTS `tbl_hms_payroll_settings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_hms_payroll_settings` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `facility_id` int(11) NOT NULL,
  `tax_year` smallint(6) NOT NULL,
  `employer_cnps_number` varchar(32) NOT NULL DEFAULT '',
  `employer_niu` varchar(32) NOT NULL DEFAULT '',
  `cnps_regime` tinyint(4) NOT NULL DEFAULT 1,
  `employer_address` varchar(500) NOT NULL DEFAULT '',
  `employer_phone` varchar(64) NOT NULL DEFAULT '',
  `employer_email` varchar(128) NOT NULL DEFAULT '',
  `cnps_employee_rate` decimal(8,3) NOT NULL DEFAULT 2.800,
  `cimr_employee_rate` decimal(8,3) NOT NULL DEFAULT 2.400,
  `crtv_rate` decimal(8,3) NOT NULL DEFAULT 0.200,
  `council_tax_rate` decimal(8,3) NOT NULL DEFAULT 0.800,
  `development_tax_rate` decimal(8,3) NOT NULL DEFAULT 0.500,
  `cnhc_rate` decimal(8,3) NOT NULL DEFAULT 0.500,
  `tax_brackets` text DEFAULT NULL,
  `default_sector` varchar(40) NOT NULL DEFAULT 'medical',
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_hms_payroll_settings_fac_year` (`facility_id`,`tax_year`),
  KEY `fk_hms_payroll_settings_fac` (`facility_id`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_hms_payroll_settings`
--

LOCK TABLES `tbl_hms_payroll_settings` WRITE;
/*!40000 ALTER TABLE `tbl_hms_payroll_settings` DISABLE KEYS */;
INSERT INTO `tbl_hms_payroll_settings` VALUES (1,1,2026,'','',1,'','','',4.200,1.000,0.000,0.000,1.000,0.000,'[{\"min\":0,\"max\":166666,\"rate\":10},{\"min\":166667,\"max\":250000,\"rate\":15},{\"min\":250001,\"max\":416666,\"rate\":25},{\"min\":416667,\"max\":null,\"rate\":35}]','medical','2026-05-20 02:39:55');
/*!40000 ALTER TABLE `tbl_hms_payroll_settings` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_hr_attendance`
--

DROP TABLE IF EXISTS `tbl_hr_attendance`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_hr_attendance` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `employee_id` int(11) NOT NULL,
  `attendance_date` date NOT NULL,
  `status` varchar(24) DEFAULT 'present',
  `check_in_time` time DEFAULT NULL,
  `check_out_time` time DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_emp_day` (`employee_id`,`attendance_date`),
  KEY `idx_day` (`attendance_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_hr_attendance`
--

LOCK TABLES `tbl_hr_attendance` WRITE;
/*!40000 ALTER TABLE `tbl_hr_attendance` DISABLE KEYS */;
/*!40000 ALTER TABLE `tbl_hr_attendance` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tbl_role`
--

DROP TABLE IF EXISTS `tbl_role`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `tbl_role` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `role` varchar(50) NOT NULL,
  `title` varchar(120) NOT NULL DEFAULT '',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_role` (`role`)
) ENGINE=InnoDB AUTO_INCREMENT=58 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tbl_role`
--

LOCK TABLES `tbl_role` WRITE;
/*!40000 ALTER TABLE `tbl_role` DISABLE KEYS */;
INSERT INTO `tbl_role` VALUES (1,'100','Doctor','2026-05-19 19:14:45'),(2,'101','Nurse','2026-05-19 19:15:22'),(3,'102','Lab Tech','2026-05-19 19:15:51'),(4,'103','Midwife','2026-05-19 19:16:21'),(5,'104','Radiologist','2026-05-19 19:19:17'),(6,'105','Pharmacist','2026-05-19 19:20:28'),(7,'106','Director','2026-05-20 09:26:10'),(8,'107','Cashier','2026-05-23 02:15:15'),(9,'1','Admin','2026-06-05 15:34:29'),(10,'99','Super Admin','2026-06-05 15:34:29'),(11,'110','Visiting Doctor','2026-06-17 03:09:24'),(12,'101','Staff','2026-06-22 03:23:01'),(13,'1','System Admin','2026-06-22 03:23:01'),(14,'99','Super Admin','2026-06-22 03:23:01'),(15,'101','Staff','2026-06-22 03:23:01'),(16,'1','System Admin','2026-06-22 03:30:30'),(17,'99','Super Admin','2026-06-22 03:30:30'),(18,'101','Staff','2026-06-22 03:30:30'),(19,'1','System Admin','2026-06-22 03:31:02'),(20,'99','Super Admin','2026-06-22 03:31:02'),(21,'101','Staff','2026-06-22 03:31:02'),(22,'1','System Admin','2026-06-22 03:52:09'),(23,'99','Super Admin','2026-06-22 03:52:09'),(24,'101','Staff','2026-06-22 03:52:09'),(25,'1','System Admin','2026-06-22 03:59:10'),(26,'99','Super Admin','2026-06-22 03:59:10'),(27,'101','Staff','2026-06-22 03:59:10'),(28,'1','System Admin','2026-06-22 03:59:22'),(29,'99','Super Admin','2026-06-22 03:59:22'),(30,'101','Staff','2026-06-22 03:59:22'),(31,'1','System Admin','2026-06-22 04:01:17'),(32,'99','Super Admin','2026-06-22 04:01:17'),(33,'101','Staff','2026-06-22 04:01:17'),(34,'1','System Admin','2026-06-22 04:04:31'),(35,'99','Super Admin','2026-06-22 04:04:31'),(36,'101','Staff','2026-06-22 04:04:31'),(37,'1','System Admin','2026-06-22 21:43:01'),(38,'99','Super Admin','2026-06-22 21:43:01'),(39,'101','Staff','2026-06-22 21:43:01'),(40,'1','System Admin','2026-06-22 21:58:58'),(41,'99','Super Admin','2026-06-22 21:58:58'),(42,'101','Staff','2026-06-22 21:58:58'),(43,'1','System Admin','2026-06-23 04:14:24'),(44,'99','Super Admin','2026-06-23 04:14:24'),(45,'101','Staff','2026-06-23 04:14:24'),(46,'1','System Admin','2026-06-23 04:28:02'),(47,'99','Super Admin','2026-06-23 04:28:02'),(48,'101','Staff','2026-06-23 04:28:02'),(49,'1','System Admin','2026-06-23 04:28:02'),(50,'99','Super Admin','2026-06-23 04:28:02'),(51,'101','Staff','2026-06-23 04:28:02'),(52,'1','System Admin','2026-06-23 05:57:09'),(53,'99','Super Admin','2026-06-23 05:57:09'),(54,'101','Staff','2026-06-23 05:57:09'),(55,'1','System Admin','2026-06-23 14:27:00'),(56,'99','Super Admin','2026-06-23 14:27:00'),(57,'101','Staff','2026-06-23 14:27:00');
/*!40000 ALTER TABLE `tbl_role` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Dumping routines for database 'zaizens_payroll'
--
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-06-24  4:37:16
